// session.ts · GET /api/v1/session · entitlement state machine
//
// Authority: AUTH_TENANCY_MODEL.md §Session endpoint behaviour
//
// R40 change: session no longer uses clerkAuth middleware (which 403s on
// missing org_id). Instead it manually verifies the JWT and dispatches to
// the entitlement gate so orgless / pending / approved / denied users all
// receive a structured response.
//
// Response shape:
//   {
//     state: 'approved_workspace' | 'authenticated_no_access' | 'pending_access' | 'access_denied' | 'needs_readiness',
//       // 'needs_readiness' (M.7): a Clerk-org first session with CUSTOMER_INAPP_READINESS_GATE on —
//       //   the frontend shows the in-app readiness journey; POST /api/v1/readiness/submit provisions.
//     user: { id, email, role },         // null only when state === 'authenticated_no_access' and user couldn't be created
//     workspace: { id, name, slug } | null,
//     projects: [...],                    // empty unless approved_workspace
//     message: string,                    // human-readable hint for the UI
//     access_request_id?: string          // surfaced when state === 'pending_access' with an open request
//   }

import { Hono } from 'hono';
import { verifyToken } from '@clerk/backend';
import { envFlagTrue } from '../lib/env-flag';
import { errorEnvelope } from '../middleware/error';
import { clerkRoleToWorkspaceRole, visibilityForRole as _vis } from '../dal/visibility';
import { buildPrincipal } from '../dal/principal-adapter';
import { projectSpineAuthority } from '../lib/spine-authority';
import { stripInternalProvisioning, customerSafeSerializerEnabled } from '../lib/customer-safe-decision'; // AR-0.2 · customer-safe projection (P3 260714: default-SAFE)
import { provisionCustomerFromAccessRequest } from '../services/onboarding-provisioner';
import type { AiRunner } from '../services/agent-digest';
import type { AuthEnv } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { neonClient } from '../db/client';
import { modelLineagePolicy } from '../lib/model-execution-lineage';

export interface SessionEnv extends AuthEnv {
  DATABASE_URL: string;
  CONTEXT_PACKET_PERSISTENCE_ENABLED?: string;
  ROLE_SKILL_CATALOG_ENABLED?: string;
  RESOLUTION_RECEIPT_SIGNING_SECRET?: string;
  RESOLUTION_RECEIPT_SIGNING_KEY_ID?: string;
  XLOOOP_DEPLOY_SHA?: string;
  ADMIN_USER_IDS?: string;
  // R43.18 · operator self-bootstrap config
  MBP_OWNER_USER_ID?: string;            // Clerk user_id of platform operator
  MBP_OPERATOR_WORKSPACE_ID?: string;    // optional override; falls back to JWT org_id then 'xlooop-internal'
  MBP_OPERATOR_WORKSPACE_NAME?: string;  // optional display name; falls back to 'Xlooop Internal'
  MBP_OPERATOR_WORKSPACE_SLUG?: string;  // optional URL slug; falls back to 'xlooop-internal'
  CUSTOMER_AUTO_PROVISION_ON_SESSION?: string; // 'true' enables idempotent Clerk-org first-session provisioning fallback
  CUSTOMER_AUTO_PROVISION_FROM_CLERK_ORG?: string; // 'true' allows operator-created Clerk org membership to create the access request + workspace on first session
  CUSTOMER_AUTO_PROVISION_APPROVER_USER_ID?: string; // audited operator/system user id for Clerk-org auto-provision
  CUSTOMER_INAPP_READINESS_GATE?: string; // M.7 · 'true' defers the Clerk-org first-session auto-provision to an in-app readiness journey: the session returns state:'needs_readiness' instead of provisioning a generic (readiness=null) workspace. POST /api/v1/readiness/submit then captures the Q&A + provisions a roadmap SCALED to the answers. Default OFF → existing flow unchanged.
  CONTEXT_RESOLVER_ENABLED?: string; // forwarded to the provisioner (readiness-context-resolver)
}

export type SessionVariables = {
  request_id: string;
  dal: DalAdapter;
};

export const sessionRoute = new Hono<{ Bindings: SessionEnv; Variables: SessionVariables }>();

void _vis; // keep import alive (re-exports are tree-shaken otherwise)

sessionRoute.get('/session', async (ctx) => {
  const requestId = (ctx.get('request_id') as string) || cryptoRandomId();
  ctx.set('request_id', requestId);

  // ---- 1. Extract JWT (401 if missing) ----
  const authHeader = ctx.req.header('authorization') || ctx.req.header('Authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    ctx.status(401);
    return ctx.json({
      error: 'Missing or invalid Authorization header',
      code: 'UNAUTHORIZED',
      request_id: requestId,
    });
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    ctx.status(401);
    return ctx.json({
      error: 'Bearer token is empty',
      code: 'UNAUTHORIZED',
      request_id: requestId,
    });
  }

  // ---- 2. Verify JWT (401 on failure) ----
  let payload: Record<string, unknown>;
  try {
    payload = await verifyToken(token, {
      secretKey: ctx.env.CLERK_SECRET_KEY,
    }) as unknown as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Token verification failed';
    ctx.status(401);
    return ctx.json({
      error: `Token verification failed: ${msg}`,
      code: 'UNAUTHORIZED',
      request_id: requestId,
    });
  }

  const userId = (payload as { sub?: string }).sub;
  const orgId = firstStringClaim(payload, ['org_id', 'organization_id']) ?? null;
  const orgRole = firstStringClaim(payload, ['org_role', 'organization_role']);
  const orgSlug = firstStringClaim(payload, ['org_slug', 'organization_slug']) ?? null;
  const orgName = firstStringClaim(payload, ['org_name', 'organization_name']) ?? null;
  const email = firstStringClaim(payload, [
    'email',
    'primary_email_address',
    'email_address',
    'primary_email',
  ]) ?? null;
  const claimedName = firstStringClaim(payload, ['name', 'full_name']) ?? null;
  const iat = (payload as { iat?: number }).iat ?? Math.floor(Date.now() / 1000);
  const exp = (payload as { exp?: number }).exp ?? null;

  if (!userId) {
    ctx.status(401);
    return ctx.json({
      error: 'JWT missing sub claim',
      code: 'UNAUTHORIZED',
      request_id: requestId,
    });
  }

  // ---- 3. Dispatch to entitlement state machine ----
  try {
    const dal = ctx.get('dal');

    // R43.18 · Operator self-bootstrap. When the requester's user_id matches
    // the configured MBP_OWNER_USER_ID, ensure they exist as an APPROVED user
    // with an active workspace_member row in the operator workspace BEFORE the
    // entitlement gate runs. Eliminates the manual seed step for the platform
    // operator — sign in via Clerk → /session call self-heals the DB state →
    // returns approved_workspace immediately.
    //
    // Safe to call repeatedly (all queries are idempotent ON CONFLICT). Runs
    // only when MBP_OWNER_USER_ID is configured AND matches the JWT user_id.
    // For non-operator users this is a no-op and they continue through the
    // regular R40 entitlement gate (which may set them to pending_access).
    const operatorUserId = ctx.env.MBP_OWNER_USER_ID;
    let bootstrapped: { workspace_id: string; workspace_name: string } | null = null;
    if (operatorUserId && operatorUserId === userId) {
      // Resolve target workspace_id with priority:
      //   1. Explicit MBP_OPERATOR_WORKSPACE_ID secret
      //   2. JWT org_id (if Clerk session has an active org)
      //   3. Default 'xlooop-internal'
      const targetWorkspaceId = ctx.env.MBP_OPERATOR_WORKSPACE_ID || orgId || 'xlooop-internal';
      const targetWorkspaceName = ctx.env.MBP_OPERATOR_WORKSPACE_NAME || 'Xlooop Internal';
      const targetWorkspaceSlug = ctx.env.MBP_OPERATOR_WORKSPACE_SLUG || 'xlooop-internal';
      try {
        await (dal as unknown as { bootstrapOperator: (args: {
          userId: string;
          workspaceId: string;
          workspaceName: string;
          workspaceSlug: string;
          email: string | null;
        }) => Promise<{ workspace_id: string; workspace_name: string }> }).bootstrapOperator({
          userId,
          workspaceId: targetWorkspaceId,
          workspaceName: targetWorkspaceName,
          workspaceSlug: targetWorkspaceSlug,
          email,
        });
        bootstrapped = { workspace_id: targetWorkspaceId, workspace_name: targetWorkspaceName };
      } catch (bootErr) {
        // Non-fatal — log via the response envelope and fall through to the
        // regular entitlement gate (which will surface the underlying DB state).
        // Don't throw — we still want the entitlement check to run.
        if (typeof console !== 'undefined' && console.warn) {
          const m = bootErr instanceof Error ? bootErr.message : String(bootErr);
          console.warn('[session] R43.18 operator self-bootstrap failed:', m);
        }
      }
    }

    let entitlement = await dal.getSessionEntitlement(userId, orgId, email);
    const canTryCustomerAutoProvision =
      entitlement.state === 'authenticated_no_access' || entitlement.state === 'pending_access';
    let autoProvisionSkippedReason: string | null = null;
    if (canTryCustomerAutoProvision && !envFlagTrue(ctx.env.CUSTOMER_AUTO_PROVISION_ON_SESSION)) {
      autoProvisionSkippedReason = 'auto_provision_disabled';
    } else if (canTryCustomerAutoProvision && !orgId) {
      autoProvisionSkippedReason = 'missing_org_id_claim';
    } else if (canTryCustomerAutoProvision && !email) {
      autoProvisionSkippedReason = 'missing_email_claim';
    }

    if (
      canTryCustomerAutoProvision &&
      envFlagTrue(ctx.env.CUSTOMER_AUTO_PROVISION_ON_SESSION) &&
      orgId &&
      email
    ) {
      try {
        let request = await findInvitedAccessRequestForSession(dal, email, orgId);
        let autoSource: 'access_request' | 'clerk_org' | null = request ? 'access_request' : null;

        if (!request && envFlagTrue(ctx.env.CUSTOMER_AUTO_PROVISION_FROM_CLERK_ORG)) {
          if (envFlagTrue(ctx.env.CUSTOMER_INAPP_READINESS_GATE)) {
            // M.7 · in-app readiness gate: do NOT auto-provision a generic
            // (readiness=null) workspace for a Clerk-org first session. Return
            // needs_readiness so the frontend renders the readiness journey; POST
            // /api/v1/readiness/submit then captures the Q&A and provisions a roadmap
            // SCALED to the answers. (A completed journey provisions → approved_workspace,
            // so reaching this branch means readiness is genuinely not yet captured.)
            (entitlement as unknown as { state: string }).state = 'needs_readiness';
            entitlement.message = 'Complete your onboarding to activate your workspace.';
          } else {
            const approvedBy = autoProvisionApprover(ctx.env);
            if (approvedBy) {
              const customerName = customerNameFromClaims({ orgName, orgSlug, email, orgId });
              const created = await dal.createAccessRequest({
                email,
                company_name: customerName,
                reason: 'Operator-created Clerk organization accepted; session-first customer provisioning.',
                source: 'clerk-org-session-auto-provision',
              });
              // Do not set invited_to_workspace_id here: access_requests has an FK to
              // workspaces(id), and this first-session path is exactly what creates that
              // workspace. The provisioner links the request to the workspace inside the
              // provisioning transaction after inserting workspaces(id).
              request = await dal.approveAccessRequest(created.id, approvedBy);
              autoSource = 'clerk_org';
            } else {
              autoProvisionSkippedReason = 'missing_auto_provision_approver';
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('[session] Clerk-org auto-provision skipped: CUSTOMER_AUTO_PROVISION_APPROVER_USER_ID or MBP_OWNER_USER_ID is required');
              }
            }
          }
        } else if (!request) {
          autoProvisionSkippedReason = 'clerk_org_auto_provision_disabled';
        }

        if (
          request?.reviewed_by &&
          (request.invited_to_workspace_id === orgId || (autoSource === 'clerk_org' && !request.invited_to_workspace_id))
        ) {
          const modelLineage = modelLineagePolicy({ load: () => neonClient(ctx.env.DATABASE_URL) }, ctx.env);
          await provisionCustomerFromAccessRequest(
            dal,
            {
              accessRequestId: request.id,
              clerkOrgId: orgId,
              ownerClerkId: userId,
              operatorClerkId: null,
              projectName: autoSource === 'clerk_org'
                ? `${customerNameFromClaims({ orgName, orgSlug, email, orgId })} onboarding`
                : null,
              approvedBy: request.reviewed_by,
              ai: (ctx.env as { AI?: AiRunner }).AI,
              modelLineageFactory: modelLineage.factory,
              modelLineageRequired: modelLineage.required,
            },
            {
              CONTEXT_RESOLVER_ENABLED: (ctx.env as { CONTEXT_RESOLVER_ENABLED?: string }).CONTEXT_RESOLVER_ENABLED,
              CHARTER_SEED_ENABLED: (ctx.env as { CHARTER_SEED_ENABLED?: string }).CHARTER_SEED_ENABLED,
            },
          );
          entitlement = await dal.getSessionEntitlement(userId, orgId, email);
          (entitlement as unknown as {
            auto_provisioned_from_access_request_id?: string;
            auto_provisioned_from?: string;
          }).auto_provisioned_from_access_request_id = request.id;
          (entitlement as unknown as { auto_provisioned_from?: string }).auto_provisioned_from = autoSource || 'access_request';
        } else if (!autoProvisionSkippedReason) {
          autoProvisionSkippedReason = 'no_approved_request_for_active_org';
        }
      } catch (provisionErr) {
        autoProvisionSkippedReason = 'auto_provision_failed';
        if (typeof console !== 'undefined' && console.warn) {
          const m = provisionErr instanceof Error ? provisionErr.message : String(provisionErr);
          console.warn('[session] customer auto-provision fallback skipped:', m);
        }
      }
    }
    if (autoProvisionSkippedReason && entitlement.state !== 'approved_workspace') {
      (entitlement as unknown as { auto_provision_skipped_reason?: string }).auto_provision_skipped_reason = autoProvisionSkippedReason;
      if (entitlement.state === 'pending_access') {
        entitlement.message = `${entitlement.message} Auto-provision skipped: ${autoProvisionSkippedReason}.`;
      }
    }
    // R43.18 · attach bootstrap signal so the frontend can observe what happened
    if (bootstrapped) {
      (entitlement as unknown as { operator_bootstrapped?: typeof bootstrapped }).operator_bootstrapped = bootstrapped;
    }

    // If approved_workspace, treat the DB membership role as the authorization source of truth.
    // Clerk org role may upgrade a low-privilege DB row when Clerk says org:admin, but it must
    // never downgrade a freshly provisioned owner/operator row. This avoids the bad onboarding
    // case where an operator adds the first customer as a Clerk "Member" and the session UI
    // demotes the Xlooop owner that provisioning just created.
    if (entitlement.state === 'approved_workspace' && entitlement.user && orgRole) {
      const clerkRole = clerkRoleToWorkspaceRole(orgRole);
      if ((entitlement.user.role === 'viewer' || entitlement.user.role === 'client') && clerkRole === 'operator') {
        entitlement.user.role = clerkRole;
      }
    }

    // ---- 4. R41 · Attach canonical AuthenticatedPrincipal when approved_workspace ----
    //
    // Forward-compatible with xcp-platform's @xcp/identity-contracts. Future
    // intent-ai-app-template extraction reads `principal` (canonical) rather than
    // building one from R40-shape fields. See src/workers/dal/principal-adapter.ts.
    if (
      entitlement.state === 'approved_workspace' &&
      entitlement.user &&
      entitlement.workspace &&
      orgId
    ) {
      entitlement.principal = buildPrincipal({
        clerkUserId: userId,
        clerkOrgId: orgId,
        email: entitlement.user.email || email,
        displayName: claimedName || '',
        workspaceName: entitlement.workspace.name,
        workspaceSlug: entitlement.workspace.slug,
        workspaceRole: entitlement.user.role,
        sessionIssuedAt: new Date(iat * 1000).toISOString(),
        sessionExpiresAt: exp ? new Date(exp * 1000).toISOString() : null,
        identitySource: 'oidc',
      });
    }

    // ---- 5. Wave B · the FOUR identity axes, returned SEPARATELY (new-UI §112.2 — never fuse
    // Role/OperatingMode/SessionMode/Visibility). Additive `identity` block; only when approved (has user +
    // workspace). operating_mode is the persisted canonical value (default 'watch'); visibility is the
    // caller's max client-exposure tier derived from role (system-internal | agency-visible | client-visible).
    if (entitlement.state === 'approved_workspace' && entitlement.user && entitlement.workspace) {
      let operatingMode: 'watch' | 'test' | 'operator' = 'watch';
      try { operatingMode = await dal.getOperatingMode(entitlement.user.id, entitlement.workspace.id); } catch { /* default */ }
      const role = entitlement.user.role;
      const visibility = role === 'client' ? 'client-visible' : role === 'viewer' ? 'agency-visible' : 'system-internal';
      // B1 · per-action governed-write authority the UI renders — the SAME decision authorizeSpineWrite enforces,
      // so a control is enabled iff the write will succeed (no "enabled → 403"). Mode-aware post-flip; degrade-safe.
      //
      // ROLE-SOURCE PARITY (P5(b) declared-axes verify finding, 260708): the projection MUST use the SAME role
      // the write gates read — the JWT-derived wire role (clerkRoleToWorkspaceRole(orgRole), what clerkAuth puts
      // on ctx auth) — NOT entitlement.user.role (the DB membership role, which is never downgraded and can be
      // 'owner' while the JWT says org:member → 'viewer', the onboarding case above). Feeding the DB role made
      // the flag-off projection say all-allowed while every governed write 403'd — the exact enabled→403 class
      // this projection exists to kill. identity.role stays the DB membership role (identity display); the
      // authority projection uses the enforcement's role source.
      const wireRole = orgRole ? clerkRoleToWorkspaceRole(orgRole) : role;
      let spine_authority;
      try {
        spine_authority = await projectSpineAuthority(ctx, {
          auth: {
            role: wireRole,
            user_id: entitlement.user.id,
            workspace_id: entitlement.workspace.id,
            token_expires_at: exp ? new Date(exp * 1000).toISOString() : null,
          } as never,
          mode: operatingMode,
        });
      } catch { /* projection is additive — never break /session on it */ }
      (entitlement as unknown as { identity?: unknown }).identity = {
        role,
        operating_mode: operatingMode,
        session_mode: 'authenticated', // a valid JWT reached /session; 'preview' (view-as) is a future axis value
        visibility,
        spine_authority, // { allowed_actions[], disabled_reasons{}, enforced } — undefined only if the projection threw
      };
    }

    // AR-0.2 / P3 (260714) · strip internal provisioning ids from the customer entitlement payload.
    // DEFAULT-SAFE: a missing/malformed flag serializes; only an explicit 'false' (internal testing)
    // returns the raw payload. Was envFlagTrue — fail-open whenever the wrangler var vanished.
    return ctx.json(stripInternalProvisioning(
      entitlement,
      customerSafeSerializerEnabled((ctx.env as { CUSTOMER_SAFE_SERIALIZER_ENABLED?: string }).CUSTOMER_SAFE_SERIALIZER_ENABLED),
    ));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ---- helpers ----
function cryptoRandomId(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis.crypto as any).randomUUID();
  } catch {
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function firstStringClaim(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = claimToString(payload[key]);
    if (value) return value;
  }
  return undefined;
}

function claimToString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['email_address', 'email', 'name', 'id']) {
      const nested = claimToString(record[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function findInvitedAccessRequestForSession(
  dal: DalAdapter,
  email: string,
  orgId: string,
) {
  const requests = await dal.listAccessRequests({ status: 'invited', limit: 200 });
  const emailKey = String(email || '').toLowerCase();
  return requests.find((row) =>
    String(row.email || '').toLowerCase() === emailKey &&
    row.invited_to_workspace_id === orgId &&
    !!row.reviewed_by
  );
}

function autoProvisionApprover(env: SessionEnv): string | null {
  const explicit = env.CUSTOMER_AUTO_PROVISION_APPROVER_USER_ID?.trim();
  if (explicit) return explicit;
  const owner = env.MBP_OWNER_USER_ID?.trim();
  if (owner) return owner;
  const admin = (env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).find(Boolean);
  return admin || null;
}

function customerNameFromClaims(input: {
  orgName?: string | null;
  orgSlug?: string | null;
  email?: string | null;
  orgId: string;
}): string {
  const orgName = meaningful(input.orgName);
  if (orgName) return orgName;
  const fromSlug = titleizeSlug(input.orgSlug || '');
  if (fromSlug) return fromSlug;
  const domain = String(input.email || '').split('@')[1] || '';
  const domainLabel = titleizeSlug(domain.split('.')[0] || '');
  return domainLabel || input.orgId;
}

function meaningful(value?: string | null): string {
  const s = String(value || '').trim();
  return s && !/^org_[a-z0-9]+$/i.test(s) ? s : '';
}

function titleizeSlug(value: string): string {
  return String(value || '')
    .replace(/\.[a-z]{2,}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
