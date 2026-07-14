#!/usr/bin/env node
// benchmark-external-capabilities.mjs
//
// Read-only adoption-readiness benchmark wrapper for optional external
// capabilities. This does not install or execute upstream tools; it proves the
// registry/corpus is ready for a governed backend benchmark and that no tool is
// accidentally promoted to default runtime.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const format = arg('format') || (process.argv.includes('--json') ? 'json' : 'text');
const requestedCapability = arg('capability') || 'all';

const registry = readJson('docs/architecture/backend/EXTERNAL_CAPABILITY_REGISTRY.json');
const corpus = readJson('docs/architecture/backend/EXTERNAL_CAPABILITY_BENCHMARK_CORPUS.json');
const requiredCapabilities = ['markitdown', 'hyper_extract', 'headroom'];
const failures = [];
const warnings = [];

const cases = corpus.cases || [];
const capabilities = registry.capabilities || [];
const capabilityIds = new Set(capabilities.map((capability) => capability.id));
const selectedIds = requestedCapability === 'all' ? requiredCapabilities : [requestedCapability];

for (const id of selectedIds) {
  if (!capabilityIds.has(id)) {
    failures.push({ id: 'capability_missing', capability: id });
  }
}
if (cases.length !== 20) {
  failures.push({ id: 'benchmark_corpus_case_count_invalid', expected: 20, actual: cases.length });
}

const capabilitySummaries = selectedIds.map((id) => {
  const capability = capabilities.find((item) => item.id === id);
  if (!capability) return { id, status: 'MISSING' };
  const targetedCases = cases.filter((item) => (item.capability_targets || []).includes(id));
  const unsafeDefault =
    capability.adopted_by_default !== false ||
    !['benchmark_candidate', 'native_rebuild_candidate'].includes(capability.status);
  if (unsafeDefault) {
    failures.push({
      id: 'capability_default_policy_invalid',
      capability: id,
      status: capability.status,
      adopted_by_default: capability.adopted_by_default,
    });
  }
  if (!targetedCases.length) {
    failures.push({ id: 'capability_has_no_corpus_cases', capability: id });
  }
  return {
    id,
    name: capability.name,
    decision_state: decisionState(capability),
    adoption_mode: capability.adoption_mode,
    status: capability.status,
    adopted_by_default: capability.adopted_by_default,
    targeted_case_count: targetedCases.length,
    allowed_scopes_if_approved: capability.allowed_scopes_if_approved || [],
    forbidden_scope_count: (capability.forbidden_scopes || []).length,
    verifier: capability.verifier,
  };
});

const gates = corpus.acceptance_gates || {};
for (const [key, expected] of Object.entries({
  extraction_fidelity_pct_min: 95,
  citation_source_span_coverage_pct_min: 95,
  answer_equivalence_pct_min: 95,
  token_reduction_pct_min: 25,
  sensitive_leakage_count: 0,
  redaction_invariant_pct: 100,
  tenant_boundary_bypass_count: 0,
  external_graph_authority_count: 0,
  replayability_pct: 100,
})) {
  if (gates[key] !== expected) {
    failures.push({ id: 'acceptance_gate_invalid', key, expected, actual: gates[key] });
  }
}

warnings.push({
  id: 'runtime_execution_not_performed',
  message: 'This benchmark wrapper validates readiness and policy posture only; upstream tools remain disabled until a sandboxed runtime benchmark is approved.',
});

const report = {
  schema_id: 'xlooop.external_capability_benchmark_readiness.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  mode: 'read_only_registry_and_corpus_benchmark',
  requested_capability: requestedCapability,
  corpus_case_count: cases.length,
  acceptance_gates: gates,
  capabilities: capabilitySummaries,
  failures,
  warnings,
};

if (format === 'json') {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`benchmark-external-capabilities · ${report.status}`);
  for (const capability of capabilitySummaries) {
    console.log(`  ${capability.id}: ${capability.decision_state} · cases=${capability.targeted_case_count}`);
  }
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

function decisionState(capability) {
  if (capability.id === 'markitdown') return 'benchmark_ready_restricted_converter_not_default';
  if (capability.id === 'hyper_extract') return 'native_rebuild_benchmark_ready_not_graph_authority';
  if (capability.id === 'headroom') return 'benchmark_ready_replay_compression_not_default';
  return 'benchmark_ready_not_default';
}
