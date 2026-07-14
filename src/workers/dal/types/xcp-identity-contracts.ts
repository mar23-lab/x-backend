// xcp-identity-contracts.ts
//
// CURATED MIRROR of @xcp/identity-contracts (xcp-platform), v0.2.0.
// Source: xcp-platform/packages/xcp-identity-contracts/src/index.ts
//
// Xlooop consumes the public-safe xcp-platform contract pack, NOT a sibling-repo file
// dependency, so Cloudflare Workers builds stay self-contained. This file mirrors ONLY
// the identity surface the Workers DAL/tests use — it intentionally OMITS upstream's
// projection / agent-runtime / paid-pilot-authority types Xlooop does not consume.
//
// Drift from upstream is gated: `npm run verify:identity-contracts` (sync-identity-contracts-from-xcp.mjs --check).
// Do NOT hand-edit the mirrored type/helper shapes — refresh from the source above and re-run the gate.

export type XcpAppId = 'xlooop' | 'xcp' | 'investor-data-room';

export type IdentitySource =
  | 'cloudflare_access'
  | 'oidc'
  | 'signed_url'
  | 'service_token'
  | 'local_dev'
  | 'test_fixture';

export type AssuranceLevel = 'low' | 'medium' | 'high';

export type OperatingMode = 'watch' | 'test' | 'operator';

export type PlatformRole =
  | 'mbp_ecosystem_operator'
  | 'xlooop_company_owner_admin'
  | 'xcp_platform_admin'
  | 'company_telemetry_viewer'
  | 'paid_pilot_customer_admin'
  | 'paid_pilot_customer_member';

export type TelemetryScope =
  | 'company_aggregate_usage'
  | 'tenant_admin_summary'
  | 'tenant_raw_break_glass'
  | 'mbp_internal_governance';

export type AppEntitlementStatus =
  | 'active'
  | 'disabled'
  | 'expired'
  | 'revoked'
  | 'pending_approval';

export type MembershipRole =
  | 'Owner'
  | 'Admin'
  | 'PM'
  | 'Engineer'
  | 'Designer'
  | 'Compliance'
  | 'Client'
  | 'Viewer'
  | 'Agent'
  | 'Service';

export interface TenantMembership {
  tenant_id: string;
  workspace_id: string;
  domain_id?: string | null;
  project_id?: string | null;
  role: MembershipRole;
  permissions: string[];
  source_ref?: string | null;
}

export interface AppEntitlement {
  app_id: XcpAppId;
  status: AppEntitlementStatus;
  enabled_by: string;
  authority_ref: string;
  risk_lane: string;
  expires_at: string | null;
  review_due: string | null;
  allowed_modes: OperatingMode[];
  allowed_actions: string[];
  denied_actions: string[];
}

export interface AuthenticatedPrincipal {
  schema_version: 'xcp.authenticated_principal.v1';
  identity_id: string;
  actor_id: string;
  email: string | null;
  display_name: string;
  identity_source: IdentitySource;
  tenant_id: string;
  owner_graph_id: string;
  memberships: TenantMembership[];
  app_entitlements: AppEntitlement[];
  permissions: string[];
  platform_roles?: PlatformRole[];
  telemetry_scopes?: TelemetryScope[];
  session_issued_at: string;
  session_expires_at: string | null;
  assurance_level: AssuranceLevel;
}

export interface AppAccessDecision {
  allowed: boolean;
  app_id: XcpAppId;
  requested_mode: OperatingMode;
  reason:
    | 'active_entitlement'
    | 'missing_entitlement'
    | 'entitlement_not_active'
    | 'mode_not_allowed'
    | 'session_expired';
  entitlement?: AppEntitlement;
}

export function findAppEntitlement(
  principal: Pick<AuthenticatedPrincipal, 'app_entitlements'>,
  appId: XcpAppId,
): AppEntitlement | undefined {
  return principal.app_entitlements.find((entitlement) => entitlement.app_id === appId);
}

export function hasActiveAppEntitlement(
  principal: AuthenticatedPrincipal,
  appId: XcpAppId,
  requestedMode: OperatingMode = 'watch',
  now: Date = new Date(),
): boolean {
  return evaluateAppAccess(principal, appId, requestedMode, now).allowed;
}

export function evaluateAppAccess(
  principal: AuthenticatedPrincipal,
  appId: XcpAppId,
  requestedMode: OperatingMode = 'watch',
  now: Date = new Date(),
): AppAccessDecision {
  if (principal.session_expires_at && Date.parse(principal.session_expires_at) <= now.getTime()) {
    return { allowed: false, app_id: appId, requested_mode: requestedMode, reason: 'session_expired' };
  }

  const entitlement = findAppEntitlement(principal, appId);
  if (!entitlement) {
    return { allowed: false, app_id: appId, requested_mode: requestedMode, reason: 'missing_entitlement' };
  }

  if (entitlement.status !== 'active') {
    return {
      allowed: false,
      app_id: appId,
      requested_mode: requestedMode,
      reason: 'entitlement_not_active',
      entitlement,
    };
  }

  if (!entitlement.allowed_modes.includes(requestedMode)) {
    return {
      allowed: false,
      app_id: appId,
      requested_mode: requestedMode,
      reason: 'mode_not_allowed',
      entitlement,
    };
  }

  return {
    allowed: true,
    app_id: appId,
    requested_mode: requestedMode,
    reason: 'active_entitlement',
    entitlement,
  };
}

export function xlooopAccessDoesNotGrantXcp(principal: AuthenticatedPrincipal): boolean {
  return hasActiveAppEntitlement(principal, 'xlooop') && !hasActiveAppEntitlement(principal, 'xcp');
}
