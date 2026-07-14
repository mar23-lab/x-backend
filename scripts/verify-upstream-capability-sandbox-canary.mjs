#!/usr/bin/env node
// Verifies the external-capability canary posture: Xlooop may run sandboxed
// adapter/native fixtures and opt-in canaries, but upstream tools are not
// default runtime until live evidence passes every gate.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const failures = [];
const warnings = [];
const checks = [];
const liveInput = arg('live-input') || process.env.XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE || '';

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
}

function pass(id, details = {}) {
  checks.push({ id, status: 'PASS', ...details });
}

function fail(id, message, details = {}) {
  failures.push({ id, message, ...details });
  checks.push({ id, status: 'FAIL', message, ...details });
}

const registry = readJson('docs/architecture/backend/EXTERNAL_CAPABILITY_REGISTRY.json');
for (const mode of ['external_benchmark', 'restricted_adapter', 'native_rebuild', 'opt_in_runtime', 'default_runtime']) {
  if ((registry.adoption_modes || []).includes(mode)) pass(`adoption_mode_present:${mode}`);
  else fail('adoption_mode_missing', 'external capability adoption mode missing', { mode });
}

const required = new Map([
  ['markitdown', 'benchmark_candidate'],
  ['hyper_extract', 'native_rebuild_candidate'],
  ['headroom', 'benchmark_candidate'],
]);
for (const [id, expectedStatus] of required.entries()) {
  const cap = (registry.capabilities || []).find((item) => item.id === id);
  if (!cap) {
    fail('capability_missing', 'capability missing from registry', { capability: id });
    continue;
  }
  if (cap.adopted_by_default === false) pass(`not_default:${id}`, { capability_status: cap.status });
  else fail('capability_default_enabled', 'capability must not be default-enabled from sandbox canary', { capability: id });
  if (cap.status === expectedStatus) pass(`expected_status:${id}`, { capability_status: cap.status });
  else fail('capability_status_unexpected', 'capability has unexpected status', { capability: id, expected: expectedStatus, actual: cap.status });
  for (const key of ['sandbox_policy', 'acceptance_gates', 'rollback_plan', 'verifier']) {
    if (cap[key]) pass(`capability_field_present:${id}:${key}`);
    else fail('capability_required_field_missing', 'capability field missing', { capability: id, key });
  }
}

const benchmark = spawnSync(process.execPath, ['scripts/benchmark-external-capabilities-runtime.mjs', '--capability=all', '--format=json', '--no-write'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (benchmark.status !== 0) {
  fail('sandbox_runtime_benchmark_failed', 'sandbox runtime benchmark failed', {
    status: benchmark.status,
    stderr: benchmark.stderr.slice(-2000),
    stdout: benchmark.stdout.slice(-2000),
  });
} else {
  const report = JSON.parse(benchmark.stdout);
  if (report.status === 'PASS') pass('sandbox_runtime_benchmark_passed', { result_count: (report.results || []).length });
  else fail('sandbox_runtime_benchmark_not_pass', 'benchmark report did not pass', { status: report.status });
  if (report.upstream_tool_execution === false) {
    pass('upstream_execution_not_claimed');
    if (liveInput) {
      pass('live_upstream_execution_validated_separately', { live_input: path.resolve(liveInput) });
    } else {
      warnings.push({
        id: 'live_upstream_execution_not_performed',
        message: 'This canary validates Xlooop sandbox/native posture. Live upstream execution remains a separate opt-in canary before default adoption.',
      });
    }
  } else {
    fail('upstream_execution_claimed_without_review', 'upstream execution must not be claimed by this verifier');
  }
  if (report.default_adoption_recommendation === 'NO') pass('default_adoption_blocked_by_canary');
  else fail('default_adoption_recommendation_not_blocked', 'sandbox canary must not recommend default adoption', { recommendation: report.default_adoption_recommendation });
}

if (liveInput) {
  verifyLiveUpstreamInput(liveInput);
} else {
  warnings.push({
    id: 'live_upstream_results_file_not_configured',
    message: 'Set XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE or --live-input after running scripts/run-upstream-capability-live-canary.mjs to validate live upstream canary evidence.',
  });
}

const report = {
  schema_id: 'xlooop.upstream_capability_sandbox_canary.verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  checks,
  failures,
  warnings,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.status === 'PASS' ? 0 : 1);

function verifyLiveUpstreamInput(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    fail('live_upstream_results_file_missing', 'configured live upstream capability results file is missing', { input: resolved });
    return;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    fail('live_upstream_results_file_invalid_json', 'configured live upstream capability results file is not valid JSON', {
      input: resolved,
      error: error.message,
    });
    return;
  }
  if (report.schema_id !== 'xlooop.external_capability_runtime_results.v1') {
    fail('live_upstream_schema_invalid', 'live upstream capability results file has unexpected schema_id', {
      input: resolved,
      schema_id: report.schema_id,
    });
  } else {
    pass('live_upstream_schema_valid', { input: resolved });
  }
  if (report.evidence_kind !== 'live_upstream_sandbox_canary') {
    fail('live_upstream_evidence_kind_invalid', 'live upstream capability results must use evidence_kind=live_upstream_sandbox_canary', {
      evidence_kind: report.evidence_kind,
    });
  } else {
    pass('live_upstream_evidence_kind_valid');
  }
  if (report.status === 'PASS') pass('live_upstream_report_passed');
  else fail('live_upstream_report_not_pass', 'live upstream capability report did not pass', { status: report.status, failures: report.failures || [] });
  if (report.upstream_tool_execution === true) pass('live_upstream_execution_claimed_with_report');
  else fail('live_upstream_execution_missing', 'live upstream canary report must include at least one real upstream tool execution');
  if (report.default_adoption_recommendation === 'NO') pass('live_upstream_default_adoption_blocked');
  else fail('live_upstream_default_adoption_not_blocked', 'live upstream canary must not recommend default adoption by itself', {
    recommendation: report.default_adoption_recommendation,
  });
  const defaultEnabled = (report.results || []).filter((item) => item.default_adoption_allowed === true);
  if (defaultEnabled.length) {
    fail('live_upstream_result_default_enabled', 'live upstream canary results must keep every capability default-disabled', {
      capabilities: defaultEnabled.map((item) => item.capability),
    });
  } else {
    pass('live_upstream_results_default_disabled', { result_count: (report.results || []).length });
  }
  if ((report.warnings || []).length) {
    warnings.push(...report.warnings.map((item) => ({ ...item, source: 'live_upstream_report' })));
  }
}

function arg(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : '';
}
