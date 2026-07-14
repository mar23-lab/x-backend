#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const strict = args.has('--strict') || process.env.XLOOOP_REQUIRE_PRODUCTION_BOUNDARY === '1';
const receiptPath = process.env.XLOOOP_PRODUCTION_BOUNDARY_RECEIPT
  || 'docs/deployment/evidence/latest-customer-feedback-production-boundary-receipt.json';

const failures = [];
const blockers = [];
const evidence = [];

const readiness = readJson('data/production-pilot-readiness.json');
const serverContract = readJson('data/server-tenant-policy-contract.json');

check(readiness?.summary?.paid_customer_pilot_status === 'operator_gated_go_with_restrictions',
  'paid_pilot_operator_gated',
  'controlled paid pilot must be go_with_restrictions and operator-gated, not public/self-serve');
check(readiness?.summary?.operator_gate_required === true,
  'operator_gate_required',
  'private paid Operator mode must require Marat onboarding decision and evidence');
check(readiness?.summary?.commercial_demo_scope === 'static_demo_only',
  'commercial_scope_static_demo_only',
  'commercial demo scope must stay labelled static_demo_only while private Operator is blocked');
check(serverContract?.backend_authority_scope === 'customer_feedback_non_production',
  'backend_scope_non_production',
  'server tenant policy must label current backend authority as customer_feedback_non_production');
check(serverContract?.app_entitlement_policy?.xlooop_access_does_not_grant_xcp === true,
  'xlooop_does_not_grant_xcp',
  'Xlooop entitlement must not grant XCP access');
check(serverContract?.telemetry_scope_policy?.tenant_raw_break_glass?.default_granted === false,
  'raw_break_glass_default_denied',
  'raw tenant break-glass scope must be default denied');

const receipt = readJsonIfExists(receiptPath);
if (!receipt) {
  blockers.push({
    id: 'missing_cloud_production_boundary_receipt',
    required_evidence: receiptPath,
    reason: 'Repo contracts pass, but deployed Cloudflare Access/D1/API/redaction/monitoring/legal evidence has not been recorded.',
  });
} else {
  validateReceipt(receipt);
}

const go = failures.length === 0 && blockers.length === 0;
const customerFeedbackProposalBoundaryStatus = go ? 'go' : 'operator_gated_until_cloud_and_signoff_evidence';
const report = {
  schema_version: 'xlooop.customer_feedback_production_boundary_verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  customer_feedback_proposal_boundary_status: customerFeedbackProposalBoundaryStatus,
  production_private_operator_status: 'operator_gated_private_operator_requires_separate_receipt',
  production_private_operator_blocker: {
    id: 'private_operator_out_of_scope_for_customer_feedback_proposal_boundary',
    reason: 'This verifier proves customer-feedback Watch/Test/proposal-only boundary evidence. Private/customer Operator mode requires a separate receipt proving entitled principal, action permission, idempotency, audited receipt, rollback, monitoring, incident/SLA, and legal/commercial sign-off.',
  },
  deprecated_status_alias: {
    field: 'production_private_operator_status',
    previous_ambiguous_go_value_replaced_by: 'customer_feedback_proposal_boundary_status',
  },
  strict_mode: strict,
  receipt_path: receiptPath,
  blockers,
  evidence,
  failures,
  closure_rule: [
    'Cloudflare Access JWT positive and negative checks must be proven on the deployed customer-feedback hostname.',
    'D1 proposal write/read and customer default receipt denial must be proven remotely.',
    'Customer-facing API responses, exports, feedback payloads, and health reports must pass redaction scan.',
    'Monitoring events and incident/SLA owner path must be evidenced.',
    'Legal/commercial claim sign-off must be referenced before private/customer Operator mode or production SaaS claims.',
  ],
};

console.log(JSON.stringify(report, null, 2));

if (failures.length || (strict && blockers.length)) process.exit(1);

function validateReceipt(receiptJson) {
  check(receiptJson.schema_version === 'xlooop.customer_feedback_production_boundary_receipt.v1',
    'receipt_schema_version',
    'production boundary receipt must use xlooop.customer_feedback_production_boundary_receipt.v1');
  for (const id of [
    'access_jwt_positive',
    'access_jwt_negative',
    'session_api_positive',
    'session_api_unauthenticated_fail_closed',
    'proposal_d1_write_read',
    'receipt_customer_default_denied',
    'telemetry_owner_aggregate_only',
    'redaction_scan_customer_api_responses',
    'monitoring_events_present',
  ]) {
    check(receiptJson.checks?.[id] === 'pass', `receipt_${id}`, `receipt check ${id} must be pass`);
  }
  check(Boolean(receiptJson.incident_sla_owner), 'receipt_incident_sla_owner', 'receipt must name incident/SLA owner');
  check(Boolean(receiptJson.legal_claim_signoff_ref), 'receipt_legal_claim_signoff_ref', 'receipt must cite legal/commercial claim sign-off');
  check(Boolean(receiptJson.checked_at), 'receipt_checked_at', 'receipt must include checked_at');
  check(Boolean(receiptJson.ttl_expires_at), 'receipt_ttl_expires_at', 'receipt must include ttl_expires_at');
  if (receiptJson.ttl_expires_at) {
    const ttl = Date.parse(receiptJson.ttl_expires_at);
    check(Number.isFinite(ttl), 'receipt_ttl_parseable', 'receipt ttl_expires_at must be parseable');
    if (Number.isFinite(ttl) && ttl <= Date.now()) {
      blockers.push({
        id: 'cloud_production_boundary_receipt_expired',
        required_evidence: receiptPath,
        reason: `receipt ttl_expires_at has expired: ${receiptJson.ttl_expires_at}`,
      });
    }
  }
  evidence.push({
    check: 'production_boundary_receipt_present',
    status: 'pass',
    receipt_path: receiptPath,
    hostname: receiptJson.hostname || null,
    checked_at: receiptJson.checked_at || null,
    ttl_expires_at: receiptJson.ttl_expires_at || null,
  });
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
}

function readJsonIfExists(rel) {
  const target = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function check(ok, id, message) {
  if (!ok) failures.push({ id, message });
}
