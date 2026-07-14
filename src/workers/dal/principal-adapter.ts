// principal-adapter.ts · R40 → canonical AuthenticatedPrincipal v1 shim
//
// Authority:
//   - data/xcp-shared-access-contract-pack.v1.json (vendored public-safe XCP pack)
//   - docs/architecture/backend/AUTH_TENANCY_MODEL.md §Entitlement model
//
// Why this file exists:
//   Our R40 backend authentication model is a SIMPLER SUBSET of xcp-platform's
//   canonical AuthenticatedPrincipal v1 shape. Rather than refactor R40's DB
//   schema (high risk, customer 1 is waiting), we emit the canonical shape
//   via this on-read shim. R42+ may add real `app_entitlements` table without
//   breaking R41 callers because the shape is already canonical.
//
// One-app constraint:
//   Per identity-contracts core rule, "Xlooop access does NOT grant XCP access."
//   This adapter ALWAYS emits a single `app_entitlements[0]` for `app_id='xlooop'`.
//   XCP entitlement is omitted — proves `xlooopAccessDoesNotGrantXcp(principal)===true`
//   by construction.

import type {
  AuthenticatedPrincipal,
  AppEntitlement,
  TenantMembership,
  MembershipRole,
  OperatingMode,
  IdentitySource,
} from './types/xcp-identity-contracts';
import type { WorkspaceRole } from './types';

// Local minimal types — only what we need from R40 to build a principal.
export interface BuildPrincipalArgs {
  clerkUserId: string;
  clerkOrgId: string;
  email: string | null;
  displayName: string;
  workspaceName: string;
  workspaceSlug: string | null;
  /** R40 WorkspaceRole (4-value). Mapped to MembershipRole (10-value) via mapRole. */
  workspaceRole: WorkspaceRole;
  /** ISO timestamp from Clerk `iat` claim. */
  sessionIssuedAt: string;
  /** ISO timestamp from Clerk `exp` claim. Null when no expiry. */
  sessionExpiresAt: string | null;
  /** Identity source — default 'oidc' (Clerk is OIDC-compliant). */
  identitySource?: IdentitySource;
}

/**
 * Maps R40's 4-value WorkspaceRole to canonical MembershipRole (10-value).
 *
 * R40 has only 4 roles. Canonical has 10. We collapse them as follows:
 *   owner    → 'Owner'   (1:1 mapping)
 *   operator → 'Admin'   (closest active-write role in the 10-value enum)
 *   viewer   → 'Viewer'  (1:1 mapping)
 *   client   → 'Client'  (1:1 mapping)
 *
 * Reversible without information loss for R41-era users.
 */
export function mapRole(role: WorkspaceRole): MembershipRole {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'operator':
      return 'Admin';
    case 'viewer':
      return 'Viewer';
    case 'client':
      return 'Client';
    default: {
      const _exhaustive: never = role;
      void _exhaustive;
      return 'Viewer';
    }
  }
}

/**
 * Maps role to allowed OperatingModes for that role's entitlement.
 *
 * Per AUTH_TENANCY_MODEL:
 *   owner, operator → full active modes (watch + test + operator)
 *   viewer, client  → read-only (watch only)
 */
export function modesForRole(role: WorkspaceRole): OperatingMode[] {
  if (role === 'owner' || role === 'operator') {
    return ['watch', 'test', 'operator'];
  }
  return ['watch'];
}

/**
 * Returns the canonical permission string list for the given R40 role.
 * Derived from the existing visibility-for-role semantics in dal/visibility.ts.
 */
export function permissionsForRole(role: WorkspaceRole): string[] {
  switch (role) {
    case 'owner':
      return [
        'workspace:read',
        'project:read',
        'event:read',
        'event:write',
        'signoff:write',
        'admin:read',
        'admin:write',
      ];
    case 'operator':
      return [
        'workspace:read',
        'project:read',
        'event:read',
        'event:write',
        'signoff:write',
        'admin:read',
      ];
    case 'viewer':
      return ['workspace:read', 'project:read', 'event:read'];
    case 'client':
      return ['event:read'];
    default:
      return [];
  }
}

/**
 * Build the canonical AuthenticatedPrincipal v1 from R40 inputs.
 *
 * Mapping:
 *   - identity_id, actor_id       = clerkUserId (same at R41; will diverge with service accounts)
 *   - email                       = users.email (DB) → fall back to Clerk email
 *   - display_name                = Clerk name → email-local-part → 'Unknown User'
 *   - identity_source             = 'oidc' (Clerk is OIDC-compliant)
 *   - tenant_id                   = clerkOrgId (= workspace.id)
 *   - owner_graph_id              = synthetic 'owner-graph:' + workspace.id (stable proxy until R-Owner-Graph)
 *   - memberships[]               = single entry with mapped role + permissions
 *   - app_entitlements[]          = single entry for 'xlooop' (XCP omitted by design)
 *   - permissions[]               = union of memberships permissions
 *   - platform_roles?             = undefined at R41 (R42+ derives from users.is_admin etc.)
 *   - telemetry_scopes?           = undefined at R41
 *   - session_issued_at, _exp     = from Clerk iat/exp claims
 *   - assurance_level             = 'medium' (Clerk OIDC, no MFA enforcement check yet)
 */
export function buildPrincipal(args: BuildPrincipalArgs): AuthenticatedPrincipal {
  const role = args.workspaceRole;
  const canonicalRole = mapRole(role);
  const permissions = permissionsForRole(role);

  const membership: TenantMembership = {
    tenant_id: args.clerkOrgId,
    workspace_id: args.clerkOrgId,
    role: canonicalRole,
    permissions,
  };

  const entitlement: AppEntitlement = {
    app_id: 'xlooop',
    status: 'active',
    enabled_by: 'r40_entitlement_gate',
    authority_ref: 'users.status=approved+workspace_members.status=active',
    risk_lane: 'customer-internal',
    expires_at: null,
    review_due: null,
    allowed_modes: modesForRole(role),
    allowed_actions: ['*'],
    denied_actions: [],
  };

  // Display-name fallback chain
  const displayName =
    args.displayName ||
    (args.email ? args.email.split('@')[0] : '') ||
    'Unknown User';

  return {
    schema_version: 'xcp.authenticated_principal.v1',
    identity_id: args.clerkUserId,
    actor_id: args.clerkUserId,
    email: args.email,
    display_name: displayName,
    identity_source: args.identitySource ?? 'oidc',
    tenant_id: args.clerkOrgId,
    owner_graph_id: `owner-graph:${args.clerkOrgId}`,
    memberships: [membership],
    app_entitlements: [entitlement],
    permissions,
    // platform_roles + telemetry_scopes intentionally omitted at R41
    session_issued_at: args.sessionIssuedAt,
    session_expires_at: args.sessionExpiresAt,
    assurance_level: 'medium',
  };
}
