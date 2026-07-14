import { customerSafeJson, json, readActionForPrincipal, requirePaidPilotPrincipal } from '../../_lib/paid-pilot-authority.js';

export async function onRequestGet({ env, request, params }) {
  const decision = await requirePaidPilotPrincipal(env, request, { appId: 'xlooop' });
  if (!decision.ok) return json({ error: decision.error, detail: decision.detail || null }, decision.status);
  const action = await readActionForPrincipal(env, decision.principal, params.id);
  if (!action) return json({ error: 'action not found' }, 404);
  return customerSafeJson({
    schema_version: 'xlooop.paid_pilot_action.v1',
    persisted: true,
    action,
  });
}
