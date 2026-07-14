import { companyTelemetry, customerSafeJson, json, requirePrincipal } from '../../_lib/customer-feedback-authority.js';

export async function onRequestGet({ env, request }) {
  if (!env.FEEDBACK_DB) return json({ error: 'FEEDBACK_DB binding required for company telemetry' }, 503);
  const decision = await requirePrincipal({
    env,
    request,
    appId: 'xlooop',
    requiredPermission: 'telemetry:company:read',
  });
  if (!decision.ok) return json({ error: decision.error, detail: decision.detail || null }, decision.status);
  const telemetry = await companyTelemetry(env, decision.principal);
  if (!telemetry.ok) return json({ error: telemetry.error }, telemetry.status);
  return customerSafeJson(telemetry.payload);
}
