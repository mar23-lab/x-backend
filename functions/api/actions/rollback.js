import { customerSafeJson, json, requirePaidPilotPrincipal, rollbackAction } from '../../_lib/paid-pilot-authority.js';

export async function onRequestPost({ env, request }) {
  const decision = await requirePaidPilotPrincipal(env, request, { appId: 'xlooop', mode: 'operator' });
  if (!decision.ok) return json({ error: decision.error, detail: decision.detail || null }, decision.status);
  const body = await request.json().catch(() => null);
  const result = await rollbackAction(env, decision.principal, body || {});
  if (!result.ok) return json({ error: result.error }, result.status || 403);
  return customerSafeJson({
    schema_version: 'xlooop.paid_pilot_action.v1',
    persisted: true,
    action: result.action,
  });
}
