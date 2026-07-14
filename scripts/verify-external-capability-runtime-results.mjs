#!/usr/bin/env node
// verify-external-capability-runtime-results.mjs
//
// Guardrail for optional external capability promotion. Passing means the
// current production state is safe: no external capability is default runtime
// unless a future runtime evidence file proves every adoption gate.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const format = arg('format') || (process.argv.includes('--json') ? 'json' : 'text');
const strict = process.argv.includes('--strict');
const requestedCapability = arg('capability') || 'all';
const registry = readJson('docs/architecture/backend/EXTERNAL_CAPABILITY_REGISTRY.json');
const runtimeResultsRel = 'docs/architecture/backend/EXTERNAL_CAPABILITY_RUNTIME_RESULTS.json';
const runtimeResultsPath = path.join(repoRoot, runtimeResultsRel);
const tmpRuntimeResultsPath = path.join(os.tmpdir(), 'xlooop-external-capability-runtime-results.json');
const inputPath = arg('input') || (fs.existsSync(runtimeResultsPath) ? runtimeResultsPath : tmpRuntimeResultsPath);
const failures = [];
const warnings = [];
const checks = [];

function pass(id, details = {}) {
  checks.push({ id, status: 'PASS', ...details });
}

function fail(id, message, details = {}) {
  failures.push({ id, message, ...details });
  checks.push({ id, status: 'FAIL', message, ...details });
}

const capabilities = registry.capabilities || [];
for (const capability of capabilities) {
  if (capability.adopted_by_default === false) {
    pass(`not_default:${capability.id}`, {
      status: capability.status,
      adoption_mode: capability.adoption_mode,
    });
  } else {
    fail('capability_default_without_runtime_evidence', 'external capabilities must not become default without runtime evidence', {
      capability: capability.id,
      adopted_by_default: capability.adopted_by_default,
    });
  }
}

if (!fs.existsSync(inputPath)) {
  const details = {
    tracked_file: runtimeResultsRel,
    tmp_file: tmpRuntimeResultsPath,
    meaning: 'No runtime-result evidence exists, so all capabilities must remain disabled by default.',
  };
  if (strict) fail('runtime_results_missing_strict', 'strict mode requires runtime benchmark evidence', details);
  else {
    pass('runtime_results_absent_default_adoption_blocked', details);
    warnings.push({
      id: 'runtime_benchmark_not_yet_executed',
      message: 'Run sandboxed runtime benchmarks before any opt-in or default adoption decision.',
    });
  }
} else {
  const runtime = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const results =
    requestedCapability === 'all'
      ? runtime.results || []
      : (runtime.results || []).filter((result) => result.capability === requestedCapability);
  if (!results.length) {
    fail('runtime_results_empty', 'runtime results are missing for requested capability', {
      requested_capability: requestedCapability,
      input: inputPath,
    });
  }
  for (const result of results) {
    verifyRuntimeResult(result);
  }
}

const report = {
  schema_id: 'xlooop.external_capability_runtime_results_verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  strict,
  requested_capability: requestedCapability,
  input: fs.existsSync(inputPath) ? inputPath : null,
  checks,
  failures,
  warnings,
};

if (format === 'json') console.log(JSON.stringify(report, null, 2));
else {
  console.log(`verify-external-capability-runtime-results · ${report.status}`);
  if (failures.length) console.error(JSON.stringify(failures, null, 2));
}

process.exit(report.status === 'PASS' ? 0 : 1);

function arg(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : '';
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
}

function verifyRuntimeResult(result) {
  const gates = result.gates || {};
  const capability = result.capability;
  if (result.default_adoption_allowed === true) {
    fail('default_adoption_not_allowed_from_runtime_fixture', 'runtime fixture cannot enable default adoption', {
      capability,
    });
  }
  const required = {
    redaction_invariant_pct: 100,
    replayability_pct: 100,
  };
  for (const [key, min] of Object.entries(required)) minGate(capability, gates, key, min);
  zeroGate(capability, gates, 'sensitive_leakage_count');
  zeroGate(capability, gates, 'tenant_boundary_bypass_count');
  zeroGate(capability, gates, 'external_graph_authority_count');
  if (gates.license_security_sbom_status !== 'PASS') {
    fail('license_security_sbom_not_pass', 'license/security/SBOM marker must pass', { capability });
  } else {
    pass(`license_security_sbom_pass:${capability}`);
  }

  if (capability === 'headroom') {
    minGate(capability, gates, 'token_reduction_pct', 25);
    minGate(capability, gates, 'answer_equivalence_pct', 95);
    minGate(capability, gates, 'citation_coverage_pct', 95);
  } else if (capability === 'markitdown') {
    minGate(capability, gates, 'extraction_fidelity_pct', 95);
    minGate(capability, gates, 'citation_source_span_coverage_pct', 95);
    const p95 = Number(gates.p95_small_doc_conversion_ms || 999999);
    if (p95 > 3000) {
      fail('p95_small_doc_conversion_above_target', 'small-doc conversion p95 target exceeded', {
        capability,
        expected_max: 3000,
        actual: p95,
      });
    } else {
      pass(`p95_small_doc_conversion_within_target:${capability}`, { actual: p95 });
    }
  } else if (capability === 'hyper_extract') {
    minGate(capability, gates, 'typed_extraction_fidelity_pct', 95);
    minGate(capability, gates, 'graph_suggestion_coverage_pct', 95);
    zeroGate(capability, gates, 'graph_suggestion_authoritative_count');
    zeroGate(capability, gates, 'direct_upstream_mcp_exposure_count');
    zeroGate(capability, gates, 'schema_drift_count');
  } else {
    minGate(capability, gates, 'answer_equivalence_pct', 95);
    minGate(capability, gates, 'citation_coverage_pct', 95);
  }
  pass(`runtime_result_reviewed:${capability}`, { decision: result.decision || 'undecided' });
}

function minGate(capability, gates, key, min) {
  const actual = Number(gates[key] || 0);
  if (actual < min) {
    fail('runtime_gate_below_threshold', 'runtime benchmark result is below threshold', {
      capability,
      key,
      expected_min: min,
      actual,
    });
  } else {
    pass(`runtime_min_gate:${capability}:${key}`, { expected_min: min, actual });
  }
}

function zeroGate(capability, gates, key) {
  const actual = Number(gates[key] || 0);
  if (actual !== 0) {
    fail('runtime_zero_gate_failed', 'runtime benchmark zero-tolerance gate failed', {
      capability,
      key,
      expected: 0,
      actual,
    });
  } else {
    pass(`runtime_zero_gate:${capability}:${key}`, { actual });
  }
}
