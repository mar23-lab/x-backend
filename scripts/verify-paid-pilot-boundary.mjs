#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const receiptPath = path.join(repoRoot, 'docs/deployment/evidence/latest-paid-pilot-boundary-receipt.json');
const failures = [];
const warnings = [];
const PLACEHOLDER_REF_RE = /\b(SMOKE-TEST-ONLY|replace-before-real-pilot|placeholder|todo|tbd)\b/i;

if (!fs.existsSync(receiptPath)) {
  failures.push('latest_paid_pilot_boundary_receipt_missing');
} else {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  check('receipt_schema', receipt.schema_version === 'xlooop.paid_pilot_boundary_receipt.v1');
  const text = JSON.stringify(receipt);
  check('receipt_secret_scan', !/(CLOUDFLARE_API_TOKEN|CF_Authorization|CF-Access-Client-Secret|sk-[A-Za-z0-9_-]+|\/Users\/maratbasyrov)/.test(text));
  if (strict) {
    check('strict_status_pass', receipt.status === 'PASS');
    check('strict_go_with_restrictions', receipt.go_with_restrictions === true);
    check('strict_ttl_fresh', Date.parse(receipt.ttl_expires_at || '') > Date.now());
    check('strict_incident_sla_owner_real_ref', isRealRef(receipt.incident_sla_owner));
    check('strict_legal_commercial_signoff_real_ref', isRealRef(receipt.legal_commercial_signoff_ref));
    for (const checkId of [
      'access_unauthenticated_fail_closed',
      'access_signed_jwt_positive',
      'access_malformed_denied',
      'xlooop_only_denied_from_xcp',
      'xcp_admin_allowed',
      'customer_operator_denied_default',
      'entitled_operator_execute_allowlisted',
      'non_allowlisted_action_denied',
      'markdown_writeback_proposal_first',
      'markdown_writeback_adapter_receipt',
      'redaction_scan',
      'monitoring_events',
      'incident_sla_owner',
      'legal_commercial_signoff',
    ]) {
      check(`strict_check:${checkId}`, receipt.checks?.[checkId]?.status === 'pass');
    }
  } else if (receipt.status !== 'PASS') {
    warnings.push(`paid_pilot_strict_receipt_not_ready:${receipt.status}`);
  }
}

const result = {
  status: failures.length ? 'FAIL' : 'PASS',
  strict,
  failures,
  warnings,
  receipt: path.relative(repoRoot, receiptPath),
};
console.log(JSON.stringify(result, null, 2));
process.exit(failures.length ? 1 : 0);

function check(id, ok) {
  if (!ok) failures.push(id);
}

function isRealRef(value) {
  return typeof value === 'string' && value.trim().length >= 12 && !PLACEHOLDER_REF_RE.test(value);
}
