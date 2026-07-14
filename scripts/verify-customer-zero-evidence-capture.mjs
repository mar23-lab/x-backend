#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const pkg = json('package.json');
const scriptSource = text('scripts/capture-customer-zero-session.mjs');
const run = spawnSync('node', [
  'scripts/capture-customer-zero-session.mjs',
  '--dry-run',
  '--workspace', 'xlooop',
  '--project', 'xlooop-commercial',
  '--goal', 'strict-evidence-and-self-serve-readiness',
  '--intent', 'customer-zero-learning-capture',
  '--observation', 'Verifier sample observation',
  '--friction', 'Comma-rich blocker keeps Access, SLA, and legal proof together',
], { cwd: repoRoot, encoding: 'utf8' });

check(pkg.scripts?.['evidence:customer-zero:capture'] === 'node scripts/capture-customer-zero-session.mjs', 'package script registered');
check(pkg.scripts?.['verify:customer-zero-evidence-capture'] === 'node scripts/verify-customer-zero-evidence-capture.mjs', 'verify script registered');
check(run.status === 0, 'dry-run exits zero', run.stderr || run.stdout);

let payload = null;
try {
  payload = JSON.parse(run.stdout);
} catch (error) {
  failures.push(`dry-run JSON parse failed: ${error.message}`);
}

const receipt = payload?.receipt || {};
const strictSatisfied = receipt.strict_paid_pilot_satisfies === true;
check(receipt.schema_version === 'xlooop.customer_zero_session_receipt.v1', 'receipt schema is v1');
check(receipt.status === 'learning_evidence_only', 'receipt is learning evidence only');
check(typeof receipt.strict_paid_pilot_satisfies === 'boolean', 'receipt captures strict paid-pilot satisfaction state');
check(receipt.private_operator_claim_allowed === strictSatisfied, 'private Operator claim follows strict paid-pilot satisfaction state');
check(receipt.production_saas_claim_allowed === false, 'receipt blocks production SaaS claim');
check(receipt.scope?.mode === 'watch_test', 'receipt defaults to Watch/Test mode');
check(Array.isArray(receipt.canonical_flow?.source_bindings) && receipt.canonical_flow.source_bindings.length >= 1, 'source bindings captured');
check(Boolean(receipt.canonical_flow?.intent_ref), 'intent ref captured');
check(Boolean(receipt.canonical_flow?.evidence_refs?.length), 'evidence refs captured');
if (strictSatisfied) {
  check(receipt.observed_state?.paid_pilot_strict_status === 'PASS', 'strict paid-pilot status is captured as passing after proof exists');
  check(Number(receipt.observed_state?.paid_pilot_strict_failure_count || 0) === 0, 'strict paid-pilot failure count is captured as zero');
} else {
  check(receipt.observed_state?.paid_pilot_strict_status !== 'PASS', 'strict paid-pilot status is fail-closed when current proof is absent or expired');
  check(Number(receipt.observed_state?.paid_pilot_strict_failure_count || 0) > 0, 'strict paid-pilot failure count explains blocked private Operator proof');
  check(/blocked until the strict receipt passes/i.test(receipt.reason || ''), 'receipt explains private Operator remains blocked without current strict proof');
}
check(Array.isArray(receipt.observed_state?.paid_pilot_strict_failures), 'strict paid-pilot failures are captured');
check(Array.isArray(receipt.blocked_claims) && receipt.blocked_claims.includes('autonomous_writeback'), 'blocked claims captured');
check(Array.isArray(receipt.blocked_claims) && receipt.blocked_claims.includes('production_saas'), 'production SaaS remains blocked');
check(Array.isArray(receipt.blocked_claims) && receipt.blocked_claims.includes('self_serve_ready'), 'self-serve remains blocked');
check(receipt.frictions?.[0] === 'Comma-rich blocker keeps Access, SLA, and legal proof together', 'comma-rich friction remains one observation');
check(!JSON.stringify(receipt).includes('/Users/maratbasyrov'), 'receipt redacts local absolute paths');
check(/strict paid-pilot/i.test(scriptSource) && /Customer Zero/i.test(scriptSource), 'script documents strict boundary and Customer Zero');
check(/xlooop-live-stream-push-receipt\.json/.test(scriptSource), 'script captures live-stream runtime push receipt when present');
check(/latest-customer-zero-session-receipt\.json/.test(scriptSource), 'script writes stable latest receipt path');

if (failures.length) {
  console.error('verify-customer-zero-evidence-capture · FAIL');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log('verify-customer-zero-evidence-capture · PASS · Customer Zero receipts are learning evidence only and claim-safe');

function json(rel) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
}

function text(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function check(ok, label, detail = '') {
  if (!ok) failures.push(`${label}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`);
}
