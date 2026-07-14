import { customerSafeJson, insertReceipt, json, operatorAllowed, receiptPayload, requirePrincipal, recordMonitoringEvent } from '../_lib/customer-feedback-authority.js';

export async function onRequestPost({ env, request }) {
  if (!env.FEEDBACK_DB) return json({ error: 'FEEDBACK_DB binding required for receipts' }, 503);
  const decision = await requirePrincipal({
    env,
    request,
    appId: 'xlooop',
    requiredMode: 'operator',
    requiredPermission: 'receipt:create',
  });
  if (!decision.ok) return json({ error: decision.error, detail: decision.detail || null }, decision.status);
  if (!operatorAllowed(decision.principal, 'xlooop')) {
    await recordMonitoringEvent(env, 'tenant_denied', {
      reason: 'operator_receipt_denied',
      tenant_id: decision.principal?.tenant_id,
      identity_id: decision.principal?.identity_id,
    });
    return json({ error: 'Operator receipt creation is disabled for this principal' }, 403);
  }
  const body = await request.json().catch(() => null);
  const row = receiptPayload(decision.principal, body || {});
  if (!row.action_id) return json({ error: 'action_id is required' }, 400);
  await insertReceipt(env, row);
  return customerSafeJson({
    schema_version: 'xlooop.customer_feedback_receipt.v1',
    persisted: true,
    receipt: row,
  });
}
