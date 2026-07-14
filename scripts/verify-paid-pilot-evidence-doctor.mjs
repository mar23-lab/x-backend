#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const script = fs.readFileSync(path.join(repoRoot, 'scripts/paid-pilot-evidence-doctor.mjs'), 'utf8');
const preflight = fs.readFileSync(path.join(repoRoot, 'scripts/paid-pilot-evidence-preflight.mjs'), 'utf8');
const readiness = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/commercial-controlled-pilot-readiness.json'), 'utf8'));
const failures = [];

check('package_script_registered', pkg.scripts?.['paid-pilot:evidence:doctor'] === 'node scripts/paid-pilot-evidence-doctor.mjs');
check('preflight_package_script_registered', pkg.scripts?.['paid-pilot:evidence:preflight'] === 'node scripts/paid-pilot-evidence-preflight.mjs');
check('verify_script_registered', pkg.scripts?.['verify:paid-pilot-evidence-doctor'] === 'node scripts/verify-paid-pilot-evidence-doctor.mjs');
check('doctor_is_non_mutating', !/writeFile|appendFile|rmSync|unlinkSync|fetch\(/.test(script));
check('preflight_is_non_mutating', !/writeFile|appendFile|rmSync|unlinkSync|fetch\(/.test(preflight));
for (const env of [
  'XLOOOP_PAID_PILOT_SMOKE_URL',
  'CLOUDFLARE_ACCESS_CLIENT_ID',
  'CLOUDFLARE_ACCESS_CLIENT_SECRET',
  'XLOOOP_XCP_DENIAL_PROOF_REF',
  'XLOOOP_XCP_ADMIN_ALLOW_PROOF_REF',
  'XLOOOP_CUSTOMER_OPERATOR_DENIAL_PROOF_REF',
  'XLOOOP_MARKDOWN_WRITEBACK_RECEIPT_REF',
  'XLOOOP_REDACTION_SCAN_REF',
  'XLOOOP_INCIDENT_SLA_OWNER',
  'XLOOOP_LEGAL_CLAIM_SIGNOFF_REF',
]) {
  check(`env_mentioned:${env}`, script.includes(env));
  check(`preflight_env_mentioned:${env}`, preflight.includes(env));
}
for (const id of [
  'cloudflare_access_signed_jwt',
  'tenant_membership_xcp_entitlement',
  'customer_operator_default_deny',
  'operator_allowlist_idempotency',
  'markdown_writeback_adapter_receipt',
  'redaction_scan',
  'monitoring_events',
  'incident_sla_owner',
  'legal_commercial_signoff',
]) {
  check(`row:${id}`, script.includes(id));
  check(`preflight_row:${id}`, preflight.includes(id));
}
check('preflight_mentions_no_secret_values', preflight.includes('does not print secret values') || preflight.includes('present: Boolean(process.env'));
check('readiness_declares_doctor_command', readiness.strict_paid_pilot_receipt?.evidence_doctor === 'npm run paid-pilot:evidence:doctor');

const run = spawnSync('node', ['scripts/paid-pilot-evidence-doctor.mjs', '--json'], { cwd: repoRoot, encoding: 'utf8' });
const preflightRun = spawnSync('node', ['scripts/paid-pilot-evidence-preflight.mjs', '--json'], { cwd: repoRoot, encoding: 'utf8' });
check('doctor_json_exits_zero', run.status === 0);
check('preflight_json_exits_zero', preflightRun.status === 0);
let result = null;
let preflightResult = null;
try { result = JSON.parse(run.stdout); } catch (_) {}
try { preflightResult = JSON.parse(preflightRun.stdout); } catch (_) {}
check('doctor_json_schema', result?.schema_version === 'xlooop.paid_pilot_evidence_doctor.v1');
check('preflight_json_schema', preflightResult?.schema_version === 'xlooop.paid_pilot_evidence_preflight.v1');
check('doctor_reports_missing_count', Number.isInteger(result?.missing_count));
check('preflight_reports_missing_count', Number.isInteger(preflightResult?.missing_count));
check('doctor_never_marks_strict_pass_without_evidence', result?.status !== 'ready_to_run_strict_gate' || result?.missing_count === 0);
check('preflight_never_marks_ready_without_inputs', preflightResult?.status !== 'ready_to_renew' || preflightResult?.missing_count === 0);

if (failures.length) {
  console.error('verify-paid-pilot-evidence-doctor · FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (preflightRun.stdout) process.stdout.write(preflightRun.stdout);
  if (preflightRun.stderr) process.stderr.write(preflightRun.stderr);
  process.exit(1);
}

console.log('verify-paid-pilot-evidence-doctor · PASS · evidence doctor + preflight are non-mutating and explain strict paid-pilot blockers');

function check(id, ok) {
  if (!ok) failures.push(id);
}
