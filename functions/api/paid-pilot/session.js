import { customerSafeJson, json, requirePaidPilotPrincipal } from '../../_lib/paid-pilot-authority.js';

export async function onRequestGet({ env, request }) {
  const decision = await requirePaidPilotPrincipal(env, request, { appId: 'xlooop' });
  if (!decision.ok) return json({ error: decision.error, detail: decision.detail || null }, decision.status);
  return customerSafeJson({
    schema_version: 'xlooop.paid_pilot_session.v1',
    principal: decision.principal,
    authority_evidence: {
      cloudflare_access_jwt_signature_verified: decision.identity.signature_verified === true,
      service_token_headers_are_not_authority: true,
      xcp_default_denied_without_explicit_entitlement: decision.principal.app_entitlements.some((entry) => entry.app_id === 'xcp' && entry.status !== 'active'),
    },
    default_operating_context: decision.entitlement.allowed_modes.includes('operator') ? 'operator' : 'watch',
  });
}
