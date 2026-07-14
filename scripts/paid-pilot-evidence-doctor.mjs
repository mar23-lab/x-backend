#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiptPath = path.join(repoRoot, 'docs/deployment/evidence/latest-paid-pilot-boundary-receipt.json');
const readinessPath = path.join(repoRoot, 'data/commercial-controlled-pilot-readiness.json');
const jsonMode = process.argv.includes('--json');

const readiness = readJson(readinessPath);
const receipt = fs.existsSync(receiptPath) ? readJson(receiptPath) : null;
const receiptChecks = receipt?.checks || {};
const hasSmokeUrl = hasEnv('XLOOOP_PAID_PILOT_SMOKE_URL') || hasEnv('XLOOOP_FEEDBACK_SMOKE_URL');

const rows = [
  row('cloudflare_access_signed_jwt', hasSmokeUrl && hasEnv('CLOUDFLARE_ACCESS_CLIENT_ID') && hasEnv('CLOUDFLARE_ACCESS_CLIENT_SECRET') && pass('access_signed_jwt_positive') && pass('access_malformed_denied') && pass('access_unauthenticated_fail_closed'), 'Set XLOOOP_PAID_PILOT_SMOKE_URL and Cloudflare Access service-token credentials, then renew and confirm signed/malformed/unauthenticated checks pass.'),
  row('tenant_membership_xcp_entitlement', hasEnv('XLOOOP_XCP_DENIAL_PROOF_REF') && hasEnv('XLOOOP_XCP_ADMIN_ALLOW_PROOF_REF') && pass('xlooop_only_denied_from_xcp') && pass('xcp_admin_allowed'), 'Record tenant membership, Xlooop-only deny, and XCP admin allow proof refs before strict paid-pilot.'),
  row('customer_operator_default_deny', hasEnv('XLOOOP_CUSTOMER_OPERATOR_DENIAL_PROOF_REF') && pass('customer_operator_denied_default'), 'Record customer Operator default-deny proof for non-entitled users.'),
  row('operator_allowlist_idempotency', hasSmokeUrl && hasEnv('CLOUDFLARE_ACCESS_CLIENT_ID') && hasEnv('CLOUDFLARE_ACCESS_CLIENT_SECRET') && pass('entitled_operator_execute_allowlisted') && pass('non_allowlisted_action_denied'), 'Run the allowlisted Operator action smoke with the paid-pilot smoke URL and prove non-allowlisted actions are denied.'),
  row('markdown_writeback_adapter_receipt', hasEnv('XLOOOP_MARKDOWN_WRITEBACK_RECEIPT_REF') && pass('markdown_writeback_proposal_first') && pass('markdown_writeback_adapter_receipt'), 'Capture governed Markdown writeback adapter receipt; proposal-first must pass before any source writeback claim.'),
  row('redaction_scan', hasEnv('XLOOOP_REDACTION_SCAN_REF') && pass('redaction_scan'), 'Set XLOOOP_REDACTION_SCAN_REF to the customer-safe redaction scan receipt before strict paid-pilot.'),
  row('monitoring_events', hasSmokeUrl && hasEnv('CLOUDFLARE_ACCESS_CLIENT_ID') && hasEnv('CLOUDFLARE_ACCESS_CLIENT_SECRET') && pass('monitoring_events'), 'Capture monitoring/health event evidence for the paid-pilot action path.'),
  row('incident_sla_owner', hasEnv('XLOOOP_INCIDENT_SLA_OWNER') && pass('incident_sla_owner'), 'Set XLOOOP_INCIDENT_SLA_OWNER and prove the incident/SLA owner path is documented.'),
  row('legal_commercial_signoff', hasEnv('XLOOOP_LEGAL_CLAIM_SIGNOFF_REF') && pass('legal_commercial_signoff'), 'Set XLOOOP_LEGAL_CLAIM_SIGNOFF_REF to the owner-approved commercial/legal sign-off reference.'),
];

const missing = rows.filter(item => item.status !== 'pass');
const result = {
  schema_version: 'xlooop.paid_pilot_evidence_doctor.v1',
  status: missing.length ? 'blocked_pending_evidence' : 'ready_to_run_strict_gate',
  generated_at: new Date().toISOString(),
  receipt: path.relative(repoRoot, receiptPath),
  receipt_status: receipt?.status || 'missing',
  strict_gate: readiness.strict_paid_pilot_receipt?.strict_gate || 'npm run verify:paid-pilot-boundary:strict',
  renewal_command: readiness.strict_paid_pilot_receipt?.required_command || 'npm run evidence:paid-pilot:renew',
  checked_items: rows,
  missing_count: missing.length,
};

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`paid-pilot:evidence:doctor · ${result.status} · missing=${result.missing_count}`);
  console.log(`receipt: ${result.receipt} · status=${result.receipt_status}`);
  for (const item of rows) {
    const mark = item.status === 'pass' ? 'PASS' : 'MISSING';
    console.log(`${mark.padEnd(7)} ${item.id} · ${item.next_action}`);
  }
  console.log(`next: ${missing.length ? 'collect missing evidence, then run ' + result.renewal_command : 'run ' + result.strict_gate}`);
}

process.exit(0);

function row(id, ok, nextAction) {
  return {
    id,
    status: ok ? 'pass' : 'missing',
    next_action: nextAction,
  };
}

function pass(id) {
  return receiptChecks?.[id]?.status === 'pass';
}

function hasEnv(name) {
  return Boolean(process.env[name]);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
