import { customerSafeJson, insertProposal, json, proposalPayload, requirePrincipal } from '../_lib/customer-feedback-authority.js';

export async function onRequestPost({ env, request }) {
  if (!env.FEEDBACK_DB) return json({ error: 'FEEDBACK_DB binding required for proposals' }, 503);
  const decision = await requirePrincipal({
    env,
    request,
    appId: 'xlooop',
    requiredPermission: 'proposal:create',
  });
  if (!decision.ok) return json({ error: decision.error, detail: decision.detail || null }, decision.status);
  const body = await request.json().catch(() => null);
  const row = proposalPayload(decision.principal, body || {});
  if (!row.action_id) return json({ error: 'action_id is required' }, 400);
  await insertProposal(env, row);
  return customerSafeJson({
    schema_version: 'xlooop.customer_feedback_proposal.v1',
    persisted: true,
    proposal: row,
    receipt_policy: 'proposal_only_customer_feedback',
  });
}
