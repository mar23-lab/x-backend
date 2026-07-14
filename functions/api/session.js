import { customerSafeJson, json, requirePrincipal } from '../_lib/customer-feedback-authority.js';

export async function onRequestGet({ env, request }) {
  if (!env.FEEDBACK_DB) return json({ error: 'FEEDBACK_DB binding required for customer-feedback authority' }, 503);
  const decision = await requirePrincipal({ env, request, appId: 'xlooop' });
  if (!decision.ok) return json({ error: decision.error, detail: decision.detail || null }, decision.status);
  return customerSafeJson({
    schema_version: 'xlooop.customer_feedback_session.v1',
    principal: decision.principal,
    default_operating_context: decision.app_entitlement.allowed_modes.includes('operator') ? 'watch' : 'watch',
    customer_feedback_policy: {
      watch_enabled: decision.app_entitlement.allowed_modes.includes('watch'),
      test_enabled: decision.app_entitlement.allowed_modes.includes('test'),
      operator_enabled: decision.app_entitlement.allowed_modes.includes('operator'),
      proposal_only_by_default: !decision.app_entitlement.allowed_modes.includes('operator'),
      access_code_role: 'routing_hint_not_authority',
    },
  });
}
