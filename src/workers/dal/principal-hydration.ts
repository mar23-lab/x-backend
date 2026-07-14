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
