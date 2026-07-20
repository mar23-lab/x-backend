// admin.ts · Admin-only routes for entitlement management
//
// Authority: AUTH_TENANCY_MODEL.md §Admin approval model
//
// All routes here require clerkAuth + requireAdmin middleware (mounted in index.ts).
//
// Endpoints:
//   GET    /api/v1/admin/access-requests          · list (filter: ?status=pending)
//   GET    /api/v1/admin/access-requests/:id      · get one
//   POST   /api/v1/admin/access-requests/:id/approve   · marks invited; admin invites via Clerk separately
//   POST   /api/v1/admin/access-requests/:id/provision · server-side workspace+project+roadmap (replaces onboard-customer CLI)
//   POST   /api/v1/admin/access-requests/:id/reject    · body: { reason }
//   GET    /api/v1/admin/users                    · list users (filter: ?status=pending)
//   POST   /api/v1/admin/users/:id/approve        · set status=approved
//   POST   /api/v1/admin/users/:id/reject         · body: { reason }; set status=rejected
//   POST   /api/v1/admin/users/:id/suspend        · set status=suspended
//   POST   /api/v1/admin/users/:id/unsuspend      · set status=approved (back to active)

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { notifyCustomerApproved, type NotifierEnv } from '../services/email-notifier';
import { provisionCustomerFromAccessRequest } from '../services/onboarding-provisioner';
import type { AiRunner } from '../services/agent-digest';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { AdminEnv } from '../middleware/admin';
import type { DalAdapter } from '../dal/DalAdapter';
import type { AccessRequestStatus, UserStatus } from '../dal/types';
import { CONNECTOR_REGISTRY } from '../lib/connector-registry'; // W5-C/G10 · connector OAuth health
import { neonClient } from '../db/client';
import { modelLineagePolicy } from '../lib/model-execution-lineage';

export interface AdminRoutesEnv extends AuthEnv, AdminEnv, NotifierEnv {
  DATABASE_URL: string;
  CONTEXT_PACKET_PERSISTENCE_ENABLED?: string;
  ROLE_SKILL_CATALOG_ENABLED?: string;
  RESOLUTION_RECEIPT_SIGNING_SECRET?: string;
  RESOLUTION_RECEIPT_SIGNING_KEY_ID?: string;
  XLOOOP_DEPLOY_SHA?: string;
}

export type AdminRoutesVariables = AuthVariables & {
  dal: DalAdapter;
};

export const adminRoute = new Hono<{
  Bindings: AdminRoutesEnv;
  Variables: AdminRoutesVariables;
}>();

// ============================================================
// Access requests
// ============================================================

adminRoute.get('/admin/access-requests', async (ctx) => {
  try {
    const url = new URL(ctx.req.url);
    const status = url.searchParams.get('status') as AccessRequestStatus | null;
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200));
    const beforeId = url.searchParams.get('before_id') || undefined;

    const dal = ctx.get('dal');
    const requests = await dal.listAccessRequests({
      ...(status ? { status } : {}),
      limit,
      ...(beforeId ? { before_id: beforeId } : {}),
    });
    return ctx.json({ access_requests: requests });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

adminRoute.get('/admin/access-requests/:id', async (ctx) => {
  try {
    const id = ctx.req.param('id');
    const dal = ctx.get('dal');
    const req = await dal.getAccessRequest(id);
    if (!req) {
      ctx.status(404);
      return ctx.json({
        error: `access request ${id} not found`,
        code: 'NOT_FOUND',
        request_id: ctx.get('request_id'),
      });
    }
    return ctx.json(req);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

adminRoute.post('/admin/access-requests/:id/approve', async (ctx) => {
  try {
    const id = ctx.req.param('id');
    const auth = ctx.get('auth');
    const body = (await ctx.req.json().catch(() => ({}))) as { invited_to_workspace_id?: string };

    const dal = ctx.get('dal');
    const approveOpts = body.invited_to_workspace_id
      ? { invited_to_workspace_id: body.invited_to_workspace_id }
      : undefined;
    const req = await dal.approveAccessRequest(id, auth.user_id, approveOpts);

    // R56 Stage 3.2 · best-effort customer "you're approved" email. Never throws (a notification
    // failure must not block the approval); uses the live Cloudflare EMAIL binding in the Worker.
    const customerEmail = await notifyCustomerApproved(ctx.env, {
      email: req.email,
      company_name: req.company_name,
      app_url: 'https://app.xlooop.com',
    });

    return ctx.json({
      access_request: req,
      customer_email: { delivered: customerEmail.delivered, channel: customerEmail.channel },
      next_step: req.invited_to_workspace_id
        ? `Invite ${req.email} to Clerk org ${req.invited_to_workspace_id}; once they accept, POST /api/v1/admin/access-requests/${id}/provision { clerk_org_id, owner_clerk_id } to provision their workspace (no CLI).`
        : `Create a Clerk org for ${req.email} + invite them; once they accept, POST /api/v1/admin/access-requests/${id}/provision { clerk_org_id, owner_clerk_id } (no CLI).`,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// POST /api/v1/admin/access-requests/:id/provision
// ============================================================
//
// Server-side replacement for `npm run onboard-customer`. Once the admin has created the
// Clerk org + the invited owner has accepted (so both ids exist), this idempotently
// provisions the customer's workspace + owner/operator members + default project + day-1
// roadmap (scaled to the readiness Q&A). No local psql/CLI. Admin-gated (requireAdmin in index.ts).
adminRoute.post('/admin/access-requests/:id/provision', async (ctx) => {
  try {
    const id = ctx.req.param('id');
    const auth = ctx.get('auth');
    const body = (await ctx.req.json().catch(() => ({}))) as {
      clerk_org_id?: string;
      owner_clerk_id?: string;
      operator_clerk_id?: string;
      project_name?: string;
    };
    const clerkOrgId = (body.clerk_org_id || '').trim();
    const ownerClerkId = (body.owner_clerk_id || '').trim();
    if (!/^org_[A-Za-z0-9]{5,}$/.test(clerkOrgId) || !/^user_[A-Za-z0-9]{5,}$/.test(ownerClerkId)) {
      ctx.status(400);
      return ctx.json({
        error: 'clerk_org_id (org_…) and owner_clerk_id (user_…) are required',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    const dal = ctx.get('dal');
    const modelLineage = modelLineagePolicy({ load: () => neonClient(ctx.env.DATABASE_URL) }, ctx.env);
    const outcome = await provisionCustomerFromAccessRequest(
      dal,
      {
        accessRequestId: id,
        clerkOrgId,
        ownerClerkId,
        operatorClerkId: body.operator_clerk_id?.trim() || null,
        projectName: body.project_name?.trim() || null,
        approvedBy: auth.user_id,
        // Workers-AI binding LLM-enriches the day-1 welcome; absent → deterministic fallback.
        ai: (ctx.env as { AI?: AiRunner }).AI,
        modelLineageFactory: modelLineage.factory,
        modelLineageRequired: modelLineage.required,
      },
      // ctx_v1 resolver flag — default OFF (unset). Only 'true' enables it. PR-3 · CHARTER_SEED_ENABLED (born-OFF).
      {
        CONTEXT_RESOLVER_ENABLED: (ctx.env as { CONTEXT_RESOLVER_ENABLED?: string }).CONTEXT_RESOLVER_ENABLED,
        CHARTER_SEED_ENABLED: (ctx.env as { CHARTER_SEED_ENABLED?: string }).CHARTER_SEED_ENABLED,
      },
    );
    ctx.status(201);
    return ctx.json({
      provisioned: outcome.result,
      readiness: outcome.readiness,
      warnings: outcome.warnings,
      welcome_drafted: outcome.welcome_drafted,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// W1b · POST /admin/customer/:workspace_id/approve — record the OPERATOR-approval side of the
// IP-boundary authority record (DR-11) WITHOUT re-running provisioning. Wires the previously-dead
// recordOperatorAuthority so a customer who already consented can be unlocked post-provision.
// Admin-gated by the adminRoutes group (requireAdmin). Idempotent (upsert).
adminRoute.post('/admin/customer/:workspace_id/approve', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const workspaceId = (ctx.req.param('workspace_id') || '').trim();
    if (!workspaceId) {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'workspace_id is required',
      });
    }
    const dal = ctx.get('dal');
    // Reject a typo'd / nonexistent workspace_id BEFORE writing the operator-approval row, so an
    // admin can't create an orphaned customer_authority_consents row (no matching workspace).
    if (typeof dal.workspaceExists === 'function' && !(await dal.workspaceExists(workspaceId))) {
      return errorEnvelope(ctx, {
        status: 404,
        code: 'NOT_FOUND',
        message: `workspace ${workspaceId} not found`,
      });
    }
    await dal.recordOperatorAuthority({
      workspace_id: workspaceId,
      operator_user_id: auth.user_id,
    });
    const state = await dal.getCustomerAuthorityState(workspaceId);
    return ctx.json({
      approved: true,
      authority: {
        unlocked: state.unlocked,
        operator_approved: state.operator_approved,
        consent_acked: state.consent_acked,
      },
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// Lifecycle L2 · GET /admin/customer/approvals/pending — the operator approval inbox. Lists the
// workspaces that have CONSENTED (customer side) but are NOT yet operator-approved and NOT revoked
// — exactly the rows the operator must approve (via POST /admin/customer/:workspace_id/approve) to
// unlock connectors + invites. Replaces the curl-and-guess loop with a queue. Admin-gated by the
// adminRoutes group (requireAdmin). Read-only.
adminRoute.get('/admin/customer/approvals/pending', async (ctx) => {
  try {
    const url = new URL(ctx.req.url);
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const dal = ctx.get('dal');
    const pending = await dal.listPendingCustomerAuthorityApprovals({ limit, offset });
    return ctx.json({ pending, count: pending.length });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// W5-C/G10 · GET /admin/health/connectors — pre-flight: diff the Clerk INSTANCE's enabled OAuth
// providers against CONNECTOR_REGISTRY, so a missing/un-enabled OAuth app surfaces as a signal here
// instead of as a runtime 502 at connect time. Admin-gated. Defensive: never throws on FAPI/parse
// failure (returns signal:'UNKNOWN'). Derives the Clerk FAPI domain from the publishable key
// (pk_(live|test)_<base64(domain$)>) — no new secret needed.
adminRoute.get('/admin/health/connectors', async (ctx) => {
  try {
    const registryDeclared = CONNECTOR_REGISTRY.map((c) => c.clerk_slug);
    const freeTierSlugs = CONNECTOR_REGISTRY.filter((c) => c.tier === 'free_active').map((c) => c.clerk_slug);
    const pk = (ctx.env.CLERK_PUBLISHABLE_KEY || '').trim();

    let fapi: string | null = null;
    try {
      const decoded = atob(pk.replace(/^pk_(live|test)_/, ''));
      fapi = decoded.replace(/\$+$/, '').trim() || null;
    } catch { fapi = null; }
    if (!fapi) {
      return ctx.json({ status: 'unknown', signal: 'UNKNOWN', reason: 'could not derive Clerk FAPI domain from CLERK_PUBLISHABLE_KEY', registry_declared: registryDeclared });
    }

    let env: Record<string, unknown> | null = null;
    try {
      const res = await fetch(`https://${fapi}/v1/environment?_clerk_js_version=5`, { headers: { Accept: 'application/json' } });
      env = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      return ctx.json({ status: 'unknown', signal: 'UNKNOWN', reason: `FAPI /v1/environment fetch failed: ${(e as Error).message}`, fapi, registry_declared: registryDeclared });
    }

    // Enabled OAuth providers live under user_settings.social as { oauth_<slug>: { enabled: true } }.
    const social = ((env?.user_settings as Record<string, unknown> | undefined)?.social || {}) as Record<string, { enabled?: boolean }>;
    const clerkEnabled = Object.entries(social)
      .filter(([, v]) => v && v.enabled)
      .map(([k]) => k.replace(/^oauth_/, ''));
    const enabledSet = new Set(clerkEnabled);
    const registrySet = new Set(registryDeclared);
    const declaredNotEnabled = registryDeclared.filter((s) => !enabledSet.has(s));
    const missingInRegistry = clerkEnabled.filter((s) => !registrySet.has(s));
    const freeTierNotEnabled = freeTierSlugs.filter((s) => !enabledSet.has(s));

    return ctx.json({
      status: 'ok',
      fapi,
      clerk_enabled: clerkEnabled,
      registry_declared: registryDeclared,
      declared_not_enabled: declaredNotEnabled,   // in registry but Clerk has it off (warn)
      missing_in_registry: missingInRegistry,     // Clerk enables it but registry omits it (warn)
      free_tier_not_enabled: freeTierNotEnabled,  // a free-tier connector's OAuth app is OFF → connect would 502 (fail)
      signal: freeTierNotEnabled.length ? 'FAIL' : (declaredNotEnabled.length || missingInRegistry.length ? 'WARN' : 'OK'),
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// Track B Stage 2 · POST /admin/investor/tier-grant — admin grants an investor
// entitlement (tier-1 or tier-2; tier-2 supersedes = escalation). Admin-gated by
// the adminRoutes group (requireAdmin). This is the entitlement skeleton from
// INVESTOR_PORTAL_PRODUCTION_ARCHITECTURE.md §4a. HONEST BOUND: granting an
// entitlement does NOT expose data-room content — the content endpoints
// (/investor/data-room, /ops-stream) remain gated on the operator-decision
// safe-pack export (status=draft_not_exported). This unblocks onboarding mechanics
// only; content is Stage 3.
adminRoute.post('/admin/investor/tier-grant', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const body = (await ctx.req.json().catch(() => ({}))) as { user_id?: string; tier?: string; workspace_id?: string | null; section_filter?: unknown };
    const userId = (body.user_id || '').trim();
    const tier = (body.tier || '').trim();
    const ALLOWED_TIER = new Set(['tier-1', 'tier-2']);
    if (!userId || !ALLOWED_TIER.has(tier)) {
      ctx.status(400);
      return ctx.json({ error: 'user_id required + tier in {tier-1, tier-2}', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const entitlement = await dal.grantInvestorEntitlement(
      { userId, tier, workspaceId: body.workspace_id ?? null, sectionFilter: body.section_filter },
      auth.user_id,
    );
    if (!entitlement) {
      ctx.status(500);
      return ctx.json({ error: 'grant failed', code: 'INTERNAL', request_id: ctx.get('request_id') });
    }
    ctx.status(201);
    return ctx.json({
      entitlement,
      note: 'Entitlement granted. Data-room CONTENT remains gated on the safe-pack export (operator decision) — this grant alone does not expose content.',
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

adminRoute.post('/admin/access-requests/:id/reject', async (ctx) => {
  try {
    const id = ctx.req.param('id');
    const auth = ctx.get('auth');
    const body = (await ctx.req.json().catch(() => ({}))) as { reason?: string };
    const reason = (body.reason || '').trim();
    if (!reason) {
      ctx.status(400);
      return ctx.json({
        error: 'reason is required for rejection',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    const dal = ctx.get('dal');
    const req = await dal.rejectAccessRequest(id, auth.user_id, reason);
    return ctx.json({ access_request: req });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// Users
// ============================================================

adminRoute.get('/admin/users', async (ctx) => {
  try {
    const url = new URL(ctx.req.url);
    const status = url.searchParams.get('status') as UserStatus | null;
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200));
    const dal = ctx.get('dal');
    const users = await dal.listUsers({
      ...(status ? { status } : {}),
      limit,
    });
    return ctx.json({ users });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

adminRoute.post('/admin/users/:id/approve', async (ctx) => {
  try {
    const id = ctx.req.param('id');
    const auth = ctx.get('auth');
    const dal = ctx.get('dal');
    const user = await dal.setUserStatus(id, 'approved', auth.user_id);
    return ctx.json({ user });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

adminRoute.post('/admin/users/:id/reject', async (ctx) => {
  try {
    const id = ctx.req.param('id');
    const auth = ctx.get('auth');
    const body = (await ctx.req.json().catch(() => ({}))) as { reason?: string };
    const reason = (body.reason || '').trim();
    if (!reason) {
      ctx.status(400);
      return ctx.json({
        error: 'reason is required for rejection',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    const dal = ctx.get('dal');
    const user = await dal.setUserStatus(id, 'rejected', auth.user_id, { rejection_reason: reason });
    return ctx.json({ user });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

adminRoute.post('/admin/users/:id/suspend', async (ctx) => {
  try {
    const id = ctx.req.param('id');
    const auth = ctx.get('auth');
    const dal = ctx.get('dal');
    const user = await dal.setUserStatus(id, 'suspended', auth.user_id);
    return ctx.json({ user });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

adminRoute.post('/admin/users/:id/unsuspend', async (ctx) => {
  try {
    const id = ctx.req.param('id');
    const auth = ctx.get('auth');
    const dal = ctx.get('dal');
    const user = await dal.setUserStatus(id, 'approved', auth.user_id);
    return ctx.json({ user });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
