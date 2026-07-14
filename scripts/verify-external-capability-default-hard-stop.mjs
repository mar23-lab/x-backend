#!/usr/bin/env node
// Composed hard-stop for external capability default promotion.
//
// Normal mode proves the production-safe posture: external tools remain
// non-default and canary/benchmark only. Strict mode is the future default
// promotion gate and fails closed unless live upstream evidence and runtime
// benchmark evidence are both configured and passing.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const strictDefaults = process.argv.includes('--strict-defaults') || process.env.XLOOOP_REQUIRE_EXTERNAL_DEFAULTS === '1';
const liveResultsFile = process.env.XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE || '';
const checks = [];
const failures = [];
const warnings = [];

function run(id, command, args, options = {}) {
  const proc = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 12,
    env: process.env,
  });
  const row = {
    id,
    status: proc.status === 0 ? 'PASS' : 'FAIL',
    exit_code: proc.status,
    required_for_default: options.requiredForDefault === true,
    stdout_tail: (proc.stdout || '').slice(-1800),
    stderr_tail: (proc.stderr || '').slice(-1800),
  };
  checks.push(row);
  if (proc.status !== 0 && options.blockInternal) failures.push(row);
  if (proc.status !== 0 && options.requiredForDefault) {
    warnings.push({
      id: `${id}_default_authority_absent`,
      message: options.message || 'Required external-capability default-promotion evidence is absent.',
    });
  }
  return row;
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
}

function addCheck(id, ok, details = {}) {
  const row = { id, status: ok ? 'PASS' : 'FAIL', ...details };
  checks.push(row);
  if (!ok) failures.push(row);
}

const registry = readJson('docs/architecture/backend/EXTERNAL_CAPABILITY_REGISTRY.json');
const capabilities = registry.capabilities || [];

if (strictDefaults) {
  const liveResultsConfigured = Boolean(liveResultsFile) && fs.existsSync(path.resolve(liveResultsFile));
  const row = {
    id: 'live_upstream_results_file_required_for_default',
    status: liveResultsConfigured ? 'PASS' : 'FAIL',
    env: 'XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE',
    input: liveResultsFile ? path.resolve(liveResultsFile) : null,
  };
  checks.push(row);
  if (!liveResultsConfigured) {
    failures.push(row);
    warnings.push({
      id: 'live_upstream_results_file_missing_for_default',
      message: 'Strict external default promotion requires XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE to point to a real live upstream sandbox-canary report.',
    });
  }
}
const defaultEnabled = capabilities.filter((cap) => cap.adopted_by_default === true);
addCheck('registry_all_capabilities_default_disabled', defaultEnabled.length === 0, {
  capability_count: capabilities.length,
  default_enabled_capabilities: defaultEnabled.map((cap) => cap.id),
});

for (const cap of capabilities) {
  addCheck(`capability_has_feature_flag_gate:${cap.id}`, Boolean(cap.acceptance_gates?.tenant_feature_flag_required), {
    status_value: cap.status,
    adoption_mode: cap.adoption_mode,
  });
  addCheck(`capability_has_owner_approval_gate:${cap.id}`, Boolean(cap.acceptance_gates?.owner_approval_required), {
    approval_ref: cap.approval_ref || null,
  });
}

run('external_capability_registry', 'npm', ['run', '--silent', 'verify:external-capability-registry'], { blockInternal: true });
run('external_capability_live_prereqs', 'npm', ['run', '--silent', 'verify:external-capability-live-prereqs'], {
  blockInternal: strictDefaults,
  requiredForDefault: true,
  message: 'Live upstream sandbox prerequisites must be present before external capability default promotion.',
});
run('upstream_capability_live_canary', 'npm', ['run', '--silent', 'verify:upstream-capability-live-canary'], {
  blockInternal: false,
  requiredForDefault: true,
  message: 'Set XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE to fresh live upstream sandbox-canary evidence before default promotion.',
});
run('external_capability_runtime_results_strict', 'npm', ['run', '--silent', 'verify:external-capability-runtime-results', '--', '--strict'], {
  blockInternal: strictDefaults,
  requiredForDefault: true,
  message: 'Strict runtime benchmark evidence is required before any MarkItDown, Headroom, or Hyper-Extract-derived default runtime.',
});

const strictPrereqsPass = checks
  .filter((row) => row.required_for_default)
  .every((row) => row.status === 'PASS');
const defaultAuthority = defaultEnabled.length === 0 && strictPrereqsPass && strictDefaults;

if (strictDefaults && !defaultAuthority) {
  failures.push({
    id: 'external_default_promotion_blocked',
    status: 'FAIL',
    message: 'External capability default promotion is blocked until live upstream canary and strict runtime benchmark evidence pass with default-enabled registry changes reviewed separately.',
  });
}

const status = failures.length ? 'FAIL' : 'PASS';
const report = {
  schema_id: 'xlooop.external_capability_default_hard_stop.verifier.v1',
  status,
  strict_defaults: strictDefaults,
  external_capability_default_authority: defaultAuthority,
  internal_controlled_canary_authority: status === 'PASS' && defaultAuthority === false,
  capabilities: capabilities.map((cap) => ({
    id: cap.id,
    status: cap.status,
    adopted_by_default: cap.adopted_by_default,
    adoption_mode: cap.adoption_mode,
    approval_ref: cap.approval_ref || null,
  })),
  checks,
  failures,
  warnings,
  conclusion: defaultAuthority
    ? 'External capability default-promotion evidence is present for a reviewed promotion path.'
    : 'External capabilities remain canary/benchmark or restricted-adapter only; default runtime remains blocked.',
};

console.log(JSON.stringify(report, null, 2));
process.exit(status === 'PASS' ? 0 : 1);
