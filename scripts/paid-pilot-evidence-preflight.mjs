#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiptPath = path.join(repoRoot, 'docs/deployment/evidence/latest-paid-pilot-boundary-receipt.json');
const jsonMode = process.argv.includes('--json');
const failWhenBlocked = process.argv.includes('--strict');

const receipt = fs.existsSync(receiptPath) ? readJson(receiptPath) : null;
const checks = receipt?.checks || {};

const items = [
  {
    id: 'cloudflare_access_signed_jwt',
    label: 'Cloudflare Access JWT',
    env: ['XLOOOP_PAID_PILOT_SMOKE_URL', 'CLOUDFLARE_ACCESS_CLIENT_ID', 'CLOUDFLARE_ACCESS_CLIENT_SECRET'],
    checks: ['access_unauthenticated_fail_closed', 'access_signed_jwt_positive', 'access_malformed_denied'],
    operator_action: 'Create/use a Cloudflare Access service token for the paid-pilot hostname; export the smoke URL and service-token credentials, then renew the receipt.',
  },
  {
    id: 'tenant_membership_xcp_entitlement',
    label: 'Tenant membership + XCP entitlement',
    env: ['XLOOOP_XCP_DENIAL_PROOF_REF', 'XLOOOP_XCP_ADMIN_ALLOW_PROOF_REF'],
    checks: ['xlooop_only_denied_from_xcp', 'xcp_admin_allowed'],
    operator_action: 'Capture proof refs that an Xlooop-only user is denied from XCP and an entitled XCP admin is allowed.',
  },
  {
    id: 'customer_operator_default_deny',
    label: 'Customer Operator default-deny',
    env: ['XLOOOP_CUSTOMER_OPERATOR_DENIAL_PROOF_REF'],
    checks: ['customer_operator_denied_default'],
    operator_action: 'Capture a proof ref that a customer/non-entitled user cannot enter Operator mode by default.',
  },
  {
    id: 'operator_allowlist_idempotency',
    label: 'Allowlisted action + idempotency',
    env: ['XLOOOP_PAID_PILOT_SMOKE_URL', 'CLOUDFLARE_ACCESS_CLIENT_ID', 'CLOUDFLARE_ACCESS_CLIENT_SECRET'],
    checks: ['entitled_operator_execute_allowlisted', 'non_allowlisted_action_denied'],
    operator_action: 'Run the renewal against the paid-pilot action endpoints; it must approve/execute only the allowlisted action and deny a non-allowlisted action.',
  },
  {
    id: 'markdown_writeback_adapter_receipt',
    label: 'Markdown writeback adapter receipt',
    env: ['XLOOOP_MARKDOWN_WRITEBACK_RECEIPT_REF'],
    checks: ['markdown_writeback_proposal_first', 'markdown_writeback_adapter_receipt'],
    operator_action: 'Run/record a governed Markdown writeback adapter receipt proving proposal-first behavior before any source writeback claim.',
  },
  {
    id: 'redaction_scan',
    label: 'Redaction scan',
    env: ['XLOOOP_REDACTION_SCAN_REF'],
    checks: ['redaction_scan'],
    operator_action: 'Run the customer-safe redaction scan and export its receipt/reference as XLOOOP_REDACTION_SCAN_REF.',
  },
  {
    id: 'monitoring_events',
    label: 'Monitoring events',
    env: ['XLOOOP_PAID_PILOT_SMOKE_URL', 'CLOUDFLARE_ACCESS_CLIENT_ID', 'CLOUDFLARE_ACCESS_CLIENT_SECRET'],
    checks: ['monitoring_events'],
    operator_action: 'The renewal must create/observe the paid-pilot action health/monitoring event through the allowlisted action smoke.',
  },
  {
    id: 'incident_sla_owner',
    label: 'Incident/SLA owner',
    env: ['XLOOOP_INCIDENT_SLA_OWNER'],
    checks: ['incident_sla_owner'],
    operator_action: 'Export the named incident/SLA owner or owner ref that will respond during the pilot.',
  },
  {
    id: 'legal_commercial_signoff',
    label: 'Legal/commercial sign-off',
    env: ['XLOOOP_LEGAL_CLAIM_SIGNOFF_REF'],
    checks: ['legal_commercial_signoff'],
    operator_action: 'Export the owner-approved legal/commercial sign-off reference before making paid/private Operator claims.',
  },
];

const checkedItems = items.map((item) => {
  const envStatus = item.env.map((name) => ({ name, present: Boolean(process.env[name]) }));
  const checkStatus = item.checks.map((name) => ({ name, status: checks[name]?.status || 'missing' }));
  const missingEnv = envStatus.filter((row) => !row.present).map((row) => row.name);
  const missingChecks = checkStatus.filter((row) => row.status !== 'pass').map((row) => row.name);
  return {
    id: item.id,
    label: item.label,
    status: missingEnv.length || missingChecks.length ? 'blocked' : 'ready',
    env: envStatus,
    receipt_checks: checkStatus,
    missing_env: missingEnv,
    missing_receipt_checks: missingChecks,
    operator_action: item.operator_action,
  };
});

const blocked = checkedItems.filter((item) => item.status !== 'ready');
const result = {
  schema_version: 'xlooop.paid_pilot_evidence_preflight.v1',
  status: blocked.length ? 'blocked_pending_inputs' : 'ready_to_renew',
  generated_at: new Date().toISOString(),
  mutates_receipt: false,
  receipt: path.relative(repoRoot, receiptPath),
  receipt_status: receipt?.status || 'missing',
  missing_count: blocked.length,
  checked_items: checkedItems,
  next_command: blocked.length ? 'Collect missing inputs, then run npm run evidence:paid-pilot:renew' : 'npm run evidence:paid-pilot:renew && npm run verify:paid-pilot-boundary:strict',
};

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`paid-pilot:evidence:preflight · ${result.status} · blocked=${result.missing_count}`);
  console.log(`receipt: ${result.receipt} · status=${result.receipt_status}`);
  for (const item of checkedItems) {
    const mark = item.status === 'ready' ? 'READY' : 'BLOCKED';
    console.log(`${mark.padEnd(7)} ${item.id} · ${item.label}`);
    if (item.missing_env.length) console.log(`        missing env: ${item.missing_env.join(', ')}`);
    if (item.missing_receipt_checks.length) console.log(`        missing receipt checks: ${item.missing_receipt_checks.join(', ')}`);
    console.log(`        action: ${item.operator_action}`);
  }
  console.log(`next: ${result.next_command}`);
}

process.exit(failWhenBlocked && blocked.length ? 1 : 0);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
