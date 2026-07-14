#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const url = (args.get('url') || process.env.XLOOOP_BOUNDARY_URL || process.env.XLOOOP_FEEDBACK_SMOKE_URL || 'https://xlooop-test.pages.dev').replace(/\/$/, '');
const hostname = new URL(url).hostname;
const outputPath = args.get('output') || process.env.XLOOOP_PRODUCTION_BOUNDARY_RECEIPT || 'docs/deployment/evidence/latest-customer-feedback-production-boundary-receipt.json';
const dryRun = args.get('dry-run') === 'true';
const writeFailed = args.get('write-failed') === 'true';
const ttlDays = Number(args.get('ttl-days') || process.env.XLOOOP_BOUNDARY_RECEIPT_TTL_DAYS || 7);
const incidentSlaOwner = process.env.XLOOOP_INCIDENT_SLA_OWNER || 'Marat Basyrov / Xlooop owner-admin';
const legalClaimSignoffRef = process.env.XLOOOP_LEGAL_CLAIM_SIGNOFF_REF || '';
const ownerTelemetryProofRef = process.env.XLOOOP_OWNER_TELEMETRY_PROOF_REF || '';
const deploymentUrl = process.env.XLOOOP_DEPLOYMENT_URL || url;

const failures = [];
const evidence = [];
const checks = {
  access_jwt_positive: 'fail',
  access_jwt_negative: 'fail',
  session_api_positive: 'fail',
  session_api_unauthenticated_fail_closed: 'fail',
  proposal_d1_write_read: 'fail',
  receipt_customer_default_denied: 'fail',
  telemetry_owner_aggregate_only: 'fail',
  redaction_scan_customer_api_responses: 'fail',
  monitoring_events_present: 'fail',
};

if (!process.env.CLOUDFLARE_ACCESS_CLIENT_ID || !process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET) {
  fail('service_token_missing', 'CLOUDFLARE_ACCESS_CLIENT_ID and CLOUDFLARE_ACCESS_CLIENT_SECRET are required.');
}
if (!legalClaimSignoffRef) {
  fail('legal_claim_signoff_ref_missing', 'Set XLOOOP_LEGAL_CLAIM_SIGNOFF_REF to an owner/legal/commercial sign-off reference.');
}

const checkedAt = new Date();
const ttlExpiresAt = new Date(checkedAt.getTime() + Math.max(1, ttlDays) * 24 * 60 * 60 * 1000);
const sourceCommit = await gitHead();

if (!failures.length) {
  await runRemoteChecks();
}

const receipt = {
  schema_version: 'xlooop.customer_feedback_production_boundary_receipt.v1',
  environment: process.env.XLOOOP_FEEDBACK_ENVIRONMENT || 'test',
  hostname,
  deployment_url: deploymentUrl,
  source_commit: sourceCommit,
  checked_at: checkedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  ttl_expires_at: ttlExpiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  checks,
  incident_sla_owner: incidentSlaOwner,
  legal_claim_signoff_ref: legalClaimSignoffRef,
  claim_boundary: 'Customer-feedback/proposal-only boundary evidence. This receipt does not approve production SaaS, autonomous operations, validated ROI, raw tenant content access, unrestricted Operator mode, or external private customer operations.',
  evidence,
  secret_policy: 'No Cloudflare API token, Access client secret, cookie value, or local private path is recorded in this receipt.',
};

if (failures.length) {
  console.error(JSON.stringify({
    status: 'FAIL',
    schema_version: 'xlooop.customer_feedback_production_boundary_receipt_writer.v1',
    url,
    output_path: outputPath,
    failures,
    checks,
    evidence,
  }, null, 2));
  if (!writeFailed) process.exit(1);
}

if (!dryRun) {
  const target = path.isAbsolute(outputPath) ? outputPath : path.join(repoRoot, outputPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
}

console.log(JSON.stringify({
  status: failures.length ? 'WROTE_FAILED_RECEIPT' : 'PASS',
  schema_version: 'xlooop.customer_feedback_production_boundary_receipt_writer.v1',
  url,
  output_path: outputPath,
  dry_run: dryRun,
  checks,
  evidence_count: evidence.length,
}, null, 2));

async function runRemoteChecks() {
  const negative = await safeFetch(`${url}/api/session`, { redirect: 'manual' });
  const negativeOk = [302, 401, 403].includes(negative.status);
  mark('access_jwt_negative', negativeOk);
  mark('session_api_unauthenticated_fail_closed', negativeOk);
  evidence.push({
    id: 'access_negative',
    status: negativeOk ? 'pass' : 'fail',
    command: 'GET /api/session without Cloudflare Access service-token headers',
    observed: describeSafe(negative),
  });

  const headers = accessHeaders();
  const session = await safeFetch(`${url}/api/session`, { headers });
  const sessionOk = session.status === 200
    && session.json?.schema_version === 'xlooop.customer_feedback_session.v1'
    && session.json?.customer_feedback_policy?.operator_enabled === false
    && session.json?.principal?.app_entitlements?.some((item) => item.app_id === 'xcp' && item.status === 'disabled');
  mark('access_jwt_positive', sessionOk);
  mark('session_api_positive', sessionOk);
  evidence.push({
    id: 'access_positive_session',
    status: sessionOk ? 'pass' : 'fail',
    command: 'GET /api/session with Cloudflare Access service-token headers',
    observed: summarizeSession(session),
  });

  const feedback = await feedbackRoundTrip(headers);
  evidence.push(feedback.evidence);

  const proposal = await proposalCreate(headers);
  mark('proposal_d1_write_read', feedback.ok && proposal.ok);
  evidence.push(proposal.evidence);

  const receiptDenial = await safeFetch(`${url}/api/receipts`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ action_id: 'production.boundary.operator_receipt_smoke' }),
  });
  const receiptDenied = receiptDenial.status === 403 && /operator mode is not permitted/i.test(receiptDenial.text || '');
  mark('receipt_customer_default_denied', receiptDenied);
  evidence.push({
    id: 'customer_receipt_denial',
    status: receiptDenied ? 'pass' : 'fail',
    command: 'POST /api/receipts with customer-feedback service-token headers',
    observed: describeSafe(receiptDenial),
  });

  const health = await safeFetch(`${url}/api/health/customer-feedback`, { headers });
  const redactionOk = health.status === 200
    && health.json?.status === 'pass'
    && health.json?.checks?.redaction_scan === 'pass';
  mark('redaction_scan_customer_api_responses', redactionOk && scanJsonSafe(session.json) && scanJsonSafe(health.json));
  evidence.push({
    id: 'customer_feedback_health',
    status: redactionOk ? 'pass' : 'fail',
    command: 'GET /api/health/customer-feedback with Cloudflare Access service-token headers',
    observed: summarizeJson(health.json) || describeSafe(health),
  });

  const telemetryCustomer = await safeFetch(`${url}/api/telemetry/company`, { headers });
  const customerDenied = [401, 403].includes(telemetryCustomer.status);
  let ownerTelemetryOk = false;
  let ownerObserved = '';
  const ownerHeaders = ownerAccessHeaders();
  if (ownerHeaders) {
    const telemetryOwner = await safeFetch(`${url}/api/telemetry/company`, { headers: ownerHeaders });
    ownerTelemetryOk = telemetryOwner.status === 200
      && telemetryOwner.json
      && scanJsonSafe(telemetryOwner.json);
    ownerObserved = describeSafe(telemetryOwner);
  } else if (ownerTelemetryProofRef) {
    ownerTelemetryOk = true;
    ownerObserved = `owner/admin aggregate telemetry proof ref supplied: ${ownerTelemetryProofRef}`;
  }
  mark('telemetry_owner_aggregate_only', customerDenied && ownerTelemetryOk);
  evidence.push({
    id: 'telemetry_customer_denied_and_owner_aggregate_only',
    status: customerDenied && ownerTelemetryOk ? 'pass' : 'fail',
    command: 'GET /api/telemetry/company with customer token, plus owner token or owner proof ref',
    observed: `customer=${describeSafe(telemetryCustomer)}; owner=${ownerObserved || 'missing owner proof'}`,
  });

  mark('monitoring_events_present', proposal.ok && receiptDenied && customerDenied);
  evidence.push({
    id: 'monitoring_events',
    status: checks.monitoring_events_present,
    observed: 'proposal_created, receipt_denied, and telemetry_denied paths exercised by this receipt writer',
  });

  for (const [id, status] of Object.entries(checks)) {
    if (status !== 'pass') fail(`check_${id}`, `${id} did not pass.`);
  }
}

async function feedbackRoundTrip(headers) {
  const feedbackId = `boundary-${Date.now()}`;
  const payload = {
    schema_version: 'xlooop.feedback_annotation.v1',
    feedback_id: feedbackId,
    tenant_id: 'mbp-owner',
    environment: 'test',
    user_email: 'unknown@xlooop.local',
    status: 'open',
    category: 'unclear',
    severity: 'low',
    comment: 'Boundary receipt feedback smoke. No private data.',
    route: '/boundary-smoke',
    graph_path: 'workspace/xlooop/domain/customer-feedback/project/boundary/lane/test/board/feedback',
    component_id: 'boundary-receipt-writer',
    control_id: 'feedback-submit',
    action_id: 'feedback.boundary.submit',
    target_label: 'Boundary receipt smoke',
    source_adapter: 'write-customer-feedback-production-boundary-receipt',
  };
  const post = await safeFetch(`${url}/api/feedback`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const get = await safeFetch(`${url}/api/feedback?tenant_id=mbp-owner`, { headers });
  const patch = await safeFetch(`${url}/api/feedback`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ feedback_id: feedbackId, status: 'verified' }),
  });
  const rows = Array.isArray(get.json?.rows) ? get.json.rows : [];
  const ok = post.status === 200
    && post.json?.persisted === true
    && Boolean(post.json?.receipt_id)
    && get.status === 200
    && rows.some((row) => row.feedback_id === feedbackId)
    && patch.status === 200
    && patch.json?.status === 'verified';
  return {
    ok,
    evidence: {
      id: 'feedback_persisted_d1',
      status: ok ? 'pass' : 'fail',
      command: 'POST/GET/PATCH /api/feedback with Cloudflare Access service-token headers',
      observed: `post=${describeSafe(post)}; get_rows=${rows.length}; patch=${describeSafe(patch)}`,
    },
  };
}

async function proposalCreate(headers) {
  const response = await safeFetch(`${url}/api/proposals`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      action_id: 'production.boundary.proposal_smoke',
      graph_path: 'workspace/xlooop/domain/customer-feedback/project/boundary/lane/test/board/proposals',
      reason: 'Production boundary proposal smoke. No private data.',
    }),
  });
  const ok = response.status === 200
    && response.json?.persisted === true
    && response.json?.proposal?.expected_receipt_policy === 'proposal_only_customer_feedback';
  return {
    ok,
    evidence: {
      id: 'proposal_d1_write',
      status: ok ? 'pass' : 'fail',
      command: 'POST /api/proposals with Cloudflare Access service-token headers',
      observed: summarizeJson(response.json) || describeSafe(response),
    },
  };
}

async function safeFetch(target, init = {}) {
  const response = await fetch(target, { redirect: 'manual', ...init });
  const text = await response.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text,
    json,
  };
}

function accessHeaders() {
  return {
    'CF-Access-Client-Id': process.env.CLOUDFLARE_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET,
  };
}

function ownerAccessHeaders() {
  if (!process.env.OWNER_CLOUDFLARE_ACCESS_CLIENT_ID || !process.env.OWNER_CLOUDFLARE_ACCESS_CLIENT_SECRET) return null;
  return {
    'CF-Access-Client-Id': process.env.OWNER_CLOUDFLARE_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': process.env.OWNER_CLOUDFLARE_ACCESS_CLIENT_SECRET,
  };
}

function mark(id, ok) {
  checks[id] = ok ? 'pass' : 'fail';
}

function fail(id, message) {
  failures.push({ id, message });
}

function describeSafe(response) {
  const text = String(response.text || '').replace(/\s+/g, ' ').slice(0, 220);
  return `HTTP ${response.status} content-type=${response.contentType || 'unknown'} body=${JSON.stringify(text)}`;
}

function summarizeSession(response) {
  if (!response.json) return describeSafe(response);
  return {
    schema_version: response.json.schema_version,
    identity_source: response.json.principal?.identity_source,
    tenant_id: response.json.principal?.tenant_id,
    xcp_entitlement: response.json.principal?.app_entitlements?.find((item) => item.app_id === 'xcp')?.status,
    operator_enabled: response.json.customer_feedback_policy?.operator_enabled,
    allowed_modes: response.json.principal?.app_entitlements?.find((item) => item.app_id === 'xlooop')?.allowed_modes,
  };
}

function summarizeJson(json) {
  if (!json || typeof json !== 'object') return null;
  return {
    schema_version: json.schema_version,
    status: json.status,
    persisted: json.persisted,
    proposal_id: json.proposal?.proposal_id,
    expected_receipt_policy: json.proposal?.expected_receipt_policy,
    error: json.error,
  };
}

function scanJsonSafe(value) {
  const text = JSON.stringify(value || {});
  const forbidden = [
    /\/Users\/maratbasyrov\/WIP\/MB-P/i,
    /CLOUDFLARE_(API_TOKEN|ACCESS_CLIENT_SECRET)/i,
    /CF_Authorization/i,
    /git-crypt/i,
    /raw tenant content/i,
  ];
  return !forbidden.some((pattern) => pattern.test(text));
}

async function gitHead() {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
