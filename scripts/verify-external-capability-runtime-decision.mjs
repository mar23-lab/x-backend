#!/usr/bin/env node
// verify-external-capability-runtime-decision.mjs
//
// Capability-specific promotion guard. It accepts current "not default"
// posture when runtime results are absent, and validates ephemeral runtime
// evidence when the benchmark has been run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const capabilityId = arg('capability') || 'headroom';
const format = arg('format') || (process.argv.includes('--json') ? 'json' : 'text');
const defaultRuntimePath = path.join(os.tmpdir(), 'xlooop-external-capability-runtime-results.json');
const inputPath = arg('input') || defaultRuntimePath;
const registry = readJson('docs/architecture/backend/EXTERNAL_CAPABILITY_REGISTRY.json');
const capability = (registry.capabilities || []).find((item) => item.id === capabilityId);
const failures = [];
const warnings = [];
const checks = [];

if (!capability) {
  fail('capability_missing', 'capability is missing from registry', { capability: capabilityId });
} else {
  if (capability.adopted_by_default === false) pass('capability_not_default', { capability: capabilityId });
  else fail('capability_default_without_approval', 'capability must remain disabled by default', { capability: capabilityId });
}

if (!fs.existsSync(inputPath)) {
  warnings.push({
    id: 'runtime_results_absent',
    message: 'No runtime benchmark evidence found; default adoption remains blocked.',
    input: inputPath,
  });
  pass('runtime_absent_default_blocked', { capability: capabilityId });
} else {
  const runtime = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const result = (runtime.results || []).find((item) => item.capability === capabilityId);
  if (!result) fail('runtime_result_missing_for_capability', 'runtime result missing for capability', { capability: capabilityId });
  else verifyResult(result);
}

const report = {
  schema_id: 'xlooop.external_capability_runtime_decision_verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  capability: capabilityId,
  input: fs.existsSync(inputPath) ? inputPath : null,
  checks,
  failures,
  warnings,
};

if (format === 'json') console.log(JSON.stringify(report, null, 2));
else {
  console.log(`verify-external-capability-runtime-decision(${capabilityId}) · ${report.status}`);
  if (failures.length) console.error(JSON.stringify(failures, null, 2));
}

process.exit(report.status === 'PASS' ? 0 : 1);

function verifyResult(result) {
  const gates = result.gates || {};
  if (result.default_adoption_allowed === true) {
    fail('default_adoption_not_allowed_from_fixture', 'fixture evidence cannot enable default adoption', { capability: result.capability });
  } else {
    pass('default_adoption_blocked_by_result', { capability: result.capability, decision: result.decision });
  }
  zeroGate(gates, 'sensitive_leakage_count');
  zeroGate(gates, 'tenant_boundary_bypass_count');
  zeroGate(gates, 'external_graph_authority_count');
  minGate(gates, 'redaction_invariant_pct', 100);
  minGate(gates, 'replayability_pct', 100);
  if (gates.license_security_sbom_status !== 'PASS') {
    fail('license_security_sbom_not_pass', 'license/security/SBOM marker must pass', { capability: result.capability });
  } else {
    pass('license_security_sbom_pass', { capability: result.capability });
  }

  if (result.capability === 'headroom') {
    minGate(gates, 'token_reduction_pct', 25);
    minGate(gates, 'answer_equivalence_pct', 95);
    minGate(gates, 'citation_coverage_pct', 95);
  }
  if (result.capability === 'markitdown') {
    minGate(gates, 'extraction_fidelity_pct', 95);
    minGate(gates, 'citation_source_span_coverage_pct', 95);
    if (Number(gates.p95_small_doc_conversion_ms || 999999) > 3000) {
      fail('p95_small_doc_conversion_above_target', 'small-doc conversion p95 target exceeded', {
        actual: gates.p95_small_doc_conversion_ms,
        expected_max: 3000,
      });
    } else {
      pass('p95_small_doc_conversion_within_target', { actual: gates.p95_small_doc_conversion_ms });
    }
  }
  if (result.capability === 'hyper_extract') {
    minGate(gates, 'typed_extraction_fidelity_pct', 95);
    minGate(gates, 'graph_suggestion_coverage_pct', 95);
    zeroGate(gates, 'graph_suggestion_authoritative_count');
    zeroGate(gates, 'direct_upstream_mcp_exposure_count');
    zeroGate(gates, 'schema_drift_count');
  }
}

function minGate(gates, key, min) {
  const actual = Number(gates[key] || 0);
  if (actual < min) fail('runtime_min_gate_failed', 'runtime minimum gate failed', { key, expected_min: min, actual });
  else pass(`runtime_min_gate:${key}`, { expected_min: min, actual });
}

function zeroGate(gates, key) {
  const actual = Number(gates[key] || 0);
  if (actual !== 0) fail('runtime_zero_gate_failed', 'runtime zero-tolerance gate failed', { key, actual });
  else pass(`runtime_zero_gate:${key}`, { actual });
}

function pass(id, details = {}) {
  checks.push({ id, status: 'PASS', ...details });
}

function fail(id, message, details = {}) {
  failures.push({ id, message, ...details });
  checks.push({ id, status: 'FAIL', message, ...details });
}

function arg(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : '';
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
}
