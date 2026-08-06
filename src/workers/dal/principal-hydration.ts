// principal-hydration.ts · Wave OA-SAFE (260708) · the PRODUCTION principal builder (P0-1) — built INERT.
//
// Builds the canonical AuthenticatedPrincipal from the request AuthContext + the REAL per-(user, workspace)
// entitlement row. MembershipRole + IdentitySource + session-expiry are attached SEPARATELY from
// OperatingMode/authority. NO role→mode derivation. NO hardcoded ['*'] actions. Missing entitlement ⇒
// app_entitlements: [] ⇒ evaluateAppAccess = missing_entitlement ⇒ DENY (fail closed).
//
// NOT wired into any route/middleware yet. It REPLACES the role-derived fabrication in
// dal/principal-adapter.ts buildPrincipal() only at the operator-gated cutover (after the 055 role-mirror
// backfill populates customer_entitlements — else every user fails closed). See OPERATOR_AXIS_AUTHORITY.md.
// The legacy role-derived builder survives ONLY as buildDemoPrincipalFromRole(), behind an explicit flag,
// and THROWS if used without it — so it can never fabricate authority in prod.

import type { Sql } from '../db/client';
import type { AuthContext, WorkspaceRole } from './types';
import type {
  AuthenticatedPrincipal,
  AppEntitlement,
  MembershipRole,
  IdentitySource,
} from './types/xcp-identity-contracts';
import { getAppEntitlementRow } from './entitlement-store';
import { mapRole, modesForRole } from './principal-adapter'; // reuse role→MembershipRole map (identity, not authority)

/** PRODUCTION resolver (INERT): read the real per-(user, workspace) entitlement, then hydrate. Fail closed on
 *  a missing row. Wired into the request path only at the cutover. */
export async function resolvePrincipal(sql: Sql, auth: AuthContext): Promise<AuthenticatedPrincipal> {
  // Per-(user, workspace) grain (operator decision 260708) — scope by workspace_id so operator authority does
  // not leak across tenants for a multi-workspace user.
  const entitlement = await getAppEntitlementRow(sql, auth.user_id, auth.workspace_id); // null ⇒ deny downstream
  return buildPrincipalFromAuthContext(auth, entitlement);
}

/** PURE + testable. Entitlement is injected (already fetched) — no role→authority derivation. */
export function buildPrincipalFromAuthContext(
  auth: AuthContext,
  entitlement: AppEntitlement | null,
): AuthenticatedPrincipal {
  const canonicalRole: MembershipRole = mapRole(auth.role as WorkspaceRole); // identity label only
  const identitySource: IdentitySource = auth.service_principal ? 'service_token' : 'oidc';
  return {
    schema_version: 'xcp.authenticated_principal.v1',
    identity_id: auth.user_id,
    actor_id: auth.user_id,
    email: auth.email ?? null,
    display_name: auth.email ? auth.email.split('@')[0] : auth.user_id,
    identity_source: identitySource,
    tenant_id: auth.workspace_id,
    owner_graph_id: `owner-graph:${auth.workspace_id}`,
    memberships: [
      { tenant_id: auth.workspace_id, workspace_id: auth.workspace_id, role: canonicalRole, permissions: [] },
    ],
    // ← THE FIX: real entitlement or NONE. Never role-derived.
    app_entitlements: entitlement ? [entitlement] : [],
    permissions: [],
    session_issued_at: new Date().toISOString(), // cosmetic — evaluateAppAccess reads only expiry
    session_expires_at: auth.token_expires_at ?? null,
    assurance_level: 'medium',
  };
}

/**
 * Stage-0 MCP unblock (260806) · the ISSUANCE-DERIVED principal for customer connector tokens.
 *
 * A `svc_customer_*` principal cannot ride the human entitlement path: `customer_entitlements.user_id`
 * is an FK to `users` (mig 018) and `getAppEntitlementRow` JOINs `workspace_members` on an ACTIVE
 * membership — a service principal has neither row, so `resolvePrincipal` fails closed forever, and
 * seeding fake users/membership rows would pollute the member surface. The honest source of a token's
 * authority is the TOKEN ISSUANCE itself: an owner/operator minted it (`developer-access.ts` — human
 * Clerk session + `authorizeGovernedWrite('token:create')` + the operational flag), it carries a role,
 * a workspace binding, a packet prefix, an expiry, and revocation kills it at the auth layer (the DB
 * hash lookup only returns live rows). This builder maps that issuance into a canonical
 * AppEntitlement and lets the SAME `canActOnSpine` core decide — deny-wins, action lists, operator
 * mode — so customer agents stay entitlement-gated (the 260720 mandate) without a parallel gate.
 *
 * THE ACTION SET IS THE DOCTRINE: an agent token may REPORT work (packets, evidence, tool events,
 * approval REQUESTS, metric deltas). It may never DECIDE — sign-off, approval decisions, revocation
 * and data deletion are denied in the entitlement itself, so "host tool approval" can never
 * impersonate "business sign-off" no matter what a caller sends.
 */
export const CUSTOMER_TOKEN_ALLOWED_ACTIONS = [
  'packet:create',
  'evidence:submit',
  'approval:request',
  'tool_event:report',
  'metric_delta:record',
] as const;
export const CUSTOMER_TOKEN_DENIED_ACTIONS = [
  'signoff:decide',
  'approval:decide',
  'authority:revoke',
  'customer_data:delete',
] as const;

export function buildCustomerTokenPrincipal(auth: AuthContext): AuthenticatedPrincipal {
  const operational = auth.role === 'operator';
  const entitlement: AppEntitlement = {
    app_id: 'xlooop',
    status: 'active', // a revoked/expired token never authenticates, so a live request implies a live grant
    enabled_by: 'customer_token_issuance',
    authority_ref: `customer-token:${auth.user_id}`,
    risk_lane: 'customer-agent',
    expires_at: auth.token_expires_at ?? null,
    review_due: null,
    allowed_modes: operational ? ['operator'] : ['watch'],
    allowed_actions: operational ? [...CUSTOMER_TOKEN_ALLOWED_ACTIONS] : [],
    denied_actions: [...CUSTOMER_TOKEN_DENIED_ACTIONS],
  };
  return buildPrincipalFromAuthContext(auth, entitlement);
}

/**
 * @deprecated DEMO/TEST ONLY. The legacy role-derived fabrication (old buildPrincipal behaviour). Refuses to
 * run unless the explicit dev fallback is enabled — so it can NEVER fabricate authority in the production
 * path. Do not call from routes.
 */
export function buildDemoPrincipalFromRole(
  auth: AuthContext,
  opts: { devFallbackEnabled: boolean },
): AuthenticatedPrincipal {
  if (!opts.devFallbackEnabled) {
    throw new Error(
      'buildDemoPrincipalFromRole: refusing to fabricate a role-derived entitlement without ' +
        'ENTITLEMENT_DEV_FALLBACK. Production must hydrate from customer_entitlements.',
    );
  }
  const fabricated: AppEntitlement = {
    app_id: 'xlooop',
    status: 'active',
    enabled_by: 'DEV_FALLBACK_role_derived',
    authority_ref: 'dev-fallback',
    risk_lane: 'dev',
    expires_at: null,
    review_due: null,
    allowed_modes: modesForRole(auth.role as WorkspaceRole), // role-derived — DEV ONLY
    allowed_actions: ['*'],
    denied_actions: [],
  };
  return buildPrincipalFromAuthContext(auth, fabricated);
}
