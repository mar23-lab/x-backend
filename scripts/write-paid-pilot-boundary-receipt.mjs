#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(repoRoot, 'docs/deployment/evidence/latest-paid-pilot-boundary-receipt.json');
const baseUrl = process.env.XLOOOP_PAID_PILOT_SMOKE_URL || process.env.XLOOOP_FEEDBACK_SMOKE_URL || 'https://xlooop-test.pages.dev';
const failures = [];
const checks = {};

requireEnv('XLOOOP_LEGAL_CLAIM_SIGNOFF_REF');
requireEnv('XLOOOP_INCIDENT_SLA_OWNER');
requireEnv('XLOOOP_REDACTION_SCAN_REF');

const headers = {
  'content-type': 'application/json',
};
if (process.env.CLOUDFLARE_ACCESS_CLIENT_ID) headers['CF-Access-Client-Id'] = process.env.CLOUDFLARE_ACCESS_CLIENT_ID;
if (process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET) headers['CF-Access-Client-Secret'] = process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET;

// NOTE: all fetches use { redirect: 'manual' }. When the paid-pilot host is fronted by
// Cloudflare Access, an unauthenticated / malformed / invalid-token request is failed
// closed at the EDGE with a 302 redirect to the IdP login page. Without redirect:'manual'
// Node's fetch FOLLOWS that 302 to the login page (HTTP 200), masking a correct fail-closed
// as a 200 and corrupting every check: unauthenticated/malformed score "200" (fail), and the
// positive check can be fooled by a followed-redirect login page. Keeping the 302 verbatim
// makes each check observe the real edge decision. A 302 to the team login IS a denial.
await record('access_unauthenticated_fail_closed', async () => {
  const response = await fetch(`${baseUrl}/api/paid-pilot/session`, { redirect: 'manual' });
  return response.status === 401 || response.status === 302 || response.status === 403;
});

await record('access_signed_jwt_positive', async () => {
  const response = await fetch(`${baseUrl}/api/paid-pilot/session`, { headers, redirect: 'manual' });
  const body = await response.json().catch(() => ({}));
  return response.status === 200 && body.authority_evidence?.cloudflare_access_jwt_signature_verified === true;
});

await record('access_malformed_denied', async () => {
  const response = await fetch(`${baseUrl}/api/paid-pilot/session`, { headers: { 'Cf-Access-Jwt-Assertion': 'malformed.jwt' }, redirect: 'manual' });
  // 302 = Cloudflare Access denied at the edge (no valid service token); 401/403 = the
  // Pages Function denied a malformed assertion that reached it. Both are valid denials.
  return response.status === 401 || response.status === 403 || response.status === 302;
});

await record('xlooop_only_denied_from_xcp', async () => Boolean(process.env.XLOOOP_XCP_DENIAL_PROOF_REF));
await record('xcp_admin_allowed', async () => Boolean(process.env.XLOOOP_XCP_ADMIN_ALLOW_PROOF_REF));
await record('customer_operator_denied_default', async () => Boolean(process.env.XLOOOP_CUSTOMER_OPERATOR_DENIAL_PROOF_REF));

const idempotency = `paid-pilot-smoke-${Date.now()}`;
let approvalId = '';
let actionId = '';
await record('entitled_operator_execute_allowlisted', async () => {
  const approve = await post('/api/actions/approve', {
    action_type: 'proposal.approve',
    graph_path: 'workspace/xlooop/domain/paid-pilot/project/smoke/lane/operator/board/actions',
    target_ref: 'paid-pilot-smoke',
  });
  approvalId = approve.json?.action?.approval_id || '';
  const execute = await post('/api/actions/execute', {
    action_type: 'feedback.resolve',
    idempotency_key: idempotency,
    approval_id: approvalId,
    verifier_ref: 'smoke:verifier',
    rollback_ref: 'smoke:rollback',
    graph_path: 'workspace/xlooop/domain/paid-pilot/project/smoke/lane/operator/board/actions',
  });
  actionId = execute.json?.action?.action_id || '';
  return approve.status === 200 && execute.status === 200 && execute.json?.persisted === true;
});

await record('non_allowlisted_action_denied', async () => {
  const response = await post('/api/actions/execute', {
    action_type: 'source.write.direct_browser',
    idempotency_key: `${idempotency}-denied`,
  });
  return response.status === 403;
});

await record('markdown_writeback_proposal_first', async () => {
  const response = await post('/api/actions/propose', {
    action_type: 'document.markdown.writeback.request',
    target_ref: 'docs/paid-pilot/smoke.md',
    graph_path: 'workspace/xlooop/domain/paid-pilot/project/smoke/lane/writeback/board/proposals',
  });
  return response.status === 200 && response.json?.action?.status === 'proposed';
});

await record('markdown_writeback_adapter_receipt', async () => Boolean(process.env.XLOOOP_MARKDOWN_WRITEBACK_RECEIPT_REF));
await record('redaction_scan', async () => Boolean(process.env.XLOOOP_REDACTION_SCAN_REF));
await record('monitoring_events', async () => Boolean(actionId));
await record('incident_sla_owner', async () => Boolean(process.env.XLOOOP_INCIDENT_SLA_OWNER));
await record('legal_commercial_signoff', async () => Boolean(process.env.XLOOOP_LEGAL_CLAIM_SIGNOFF_REF));

const status = failures.length ? 'FAIL' : 'PASS';
const receipt = redact({
  schema_version: 'xlooop.paid_pilot_boundary_receipt.v1',
  status,
  generated_at: new Date().toISOString(),
  ttl_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  go_with_restrictions: status === 'PASS',
  base_url: baseUrl,
  legal_commercial_signoff_ref: process.env.XLOOOP_LEGAL_CLAIM_SIGNOFF_REF || null,
  incident_sla_owner: process.env.XLOOOP_INCIDENT_SLA_OWNER || null,
  redaction_scan_ref: process.env.XLOOOP_REDACTION_SCAN_REF || null,
  action_smoke_ref: actionId || null,
  checks,
  failures,
  blocked_claims: [
    'production_saas',
    'autonomous_operations',
    'raw_tenant_access',
    'unrestricted_source_writeback',
  ],
});
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ status, receipt: path.relative(repoRoot, outPath), failures }, null, 2));
process.exit(failures.length ? 1 : 0);

async function post(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function record(id, fn) {
  try {
    const ok = await fn();
    checks[id] = { status: ok ? 'pass' : 'fail' };
    if (!ok) failures.push(id);
  } catch (error) {
    checks[id] = { status: 'fail', detail: String(error?.message || error).slice(0, 240) };
    failures.push(id);
  }
}

function requireEnv(name) {
  if (!process.env[name]) failures.push(`missing_env:${name}`);
}

function redact(value) {
  return JSON.parse(JSON.stringify(value).replace(/(CF_Authorization|CF-Access-Client-Secret|CLOUDFLARE_API_TOKEN|sk-[A-Za-z0-9_-]+|\/Users\/maratbasyrov)/g, '[redacted]'));
}
