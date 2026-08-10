import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlooop-upstream-contract-'));

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('raw live runtime evidence is accepted and string warnings stay structured', () => {
  const input = writeFixture('raw.json', {
    schema_id: 'xlooop.external_capability_runtime_results.v1',
    status: 'PASS',
    evidence_kind: 'live_upstream_sandbox_canary',
    upstream_tool_execution: true,
    default_adoption_recommendation: 'NO',
    results: [{ capability: 'markitdown', default_adoption_allowed: false }],
    warnings: ['Default adoption remains blocked.'],
  });

  const result = runVerifier(input);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.warnings.at(-1), {
    id: 'live_upstream_report_warning',
    message: 'Default adoption remains blocked.',
    source: 'live_upstream_report',
  });
});

test('aggregate summary is rejected as non-authoritative runtime evidence', () => {
  const input = writeFixture('summary.json', {
    schema_id: 'xlooop.external_capability_live_canary_summary.v1',
    source_report: '/private/tmp/raw-live-results.json',
    warnings: ['Summary only.'],
  });

  const result = runVerifier(input);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.failures.at(-1).id, 'live_upstream_summary_not_runtime_evidence');
  assert.equal(report.failures.at(-1).source_report, '/private/tmp/raw-live-results.json');
  assert.deepEqual(report.warnings.at(-1), {
    id: 'live_upstream_report_warning',
    message: 'Summary only.',
    source: 'live_upstream_report',
  });
});

test('Headroom prerequisite verifier uses the current distribution contract', () => {
  const prereqSource = fs.readFileSync(
    path.join(repoRoot, 'scripts/verify-external-capability-live-prereqs.mjs'),
    'utf8',
  );

  assert.match(prereqSource, /\("headroom_ai", "headroom-ai"\)/);
  assert.match(prereqSource, /chopratejas\/headroom/);
  assert.match(prereqSource, /headroomlabs-ai\/headroom/);
});

test('Headroom live canary runs compression rather than passthrough mode', () => {
  const runnerSource = fs.readFileSync(
    path.join(repoRoot, 'scripts/run-upstream-capability-live-canary.mjs'),
    'utf8',
  );

  assert.doesNotMatch(runnerSource, /headroom\.compress\([^)]*optimize=False/s);
  assert.match(runnerSource, /optimize=True/);
  assert.match(runnerSource, /compress_user_messages=True/);
  assert.match(runnerSource, /target_ratio=0\.5/);
  assert.match(runnerSource, /replayability_pct: pct\(replayPass, selected\.length\)/);
  assert.match(runnerSource, /structural_context_invariant_preservation_not_downstream_llm_semantics/);
  assert.match(runnerSource, /headroom_live_canary_structural_equivalence_only/);
});

test('strict runtime verifier keeps structural equivalence distinct from live task equivalence', () => {
  const input = writeFixture('headroom-structural.json', {
    schema_id: 'xlooop.external_capability_runtime_results.v1',
    results: [
      {
        capability: 'headroom',
        default_adoption_allowed: false,
        decision: 'live_upstream_canary_promising_not_default',
        answer_equivalence_measurement: 'structural_context_invariant_preservation_not_downstream_llm_semantics',
        gates: {
          token_reduction_pct: 68.67,
          answer_equivalence_pct: 100,
          citation_coverage_pct: 100,
          redaction_invariant_pct: 100,
          replayability_pct: 100,
          sensitive_leakage_count: 0,
          tenant_boundary_bypass_count: 0,
          external_graph_authority_count: 0,
          license_security_sbom_status: 'PASS',
        },
      },
    ],
  });

  const result = runRuntimeVerifier(input);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'PASS');
  assert.ok(report.checks.every((check) => ['PASS', 'FAIL'].includes(check.status)));
  assert.ok(report.checks.some((check) => check.id === 'headroom_structural_equivalence_scope_declared:headroom'));
  assert.ok(report.warnings.some((warning) => warning.id === 'headroom_semantic_task_equivalence_not_measured'));
});

test('Headroom semantic runner supports a credential-safe paid/platform evaluator lane', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/run-headroom-semantic-canary.mjs'), 'utf8');

  assert.match(source, /openai-compatible/);
  assert.match(source, /XLOOOP_HEADROOM_EVALUATOR_API_KEY/);
  assert.match(source, /live_paid_or_platform_llm_semantic_canary/);
  assert.match(source, /credential_material_present: false/);
  assert.match(source, /delete env\.XLOOOP_HEADROOM_EVALUATOR_API_KEY/);
  assert.doesNotMatch(source, /evaluator:\s*\{[^}]*api_key/is);
});

test('paid/platform semantic gate belongs only to Headroom', () => {
  const registry = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'docs/architecture/backend/EXTERNAL_CAPABILITY_REGISTRY.json'),
    'utf8',
  ));
  const byId = new Map(registry.capabilities.map((capability) => [capability.id, capability]));

  assert.equal(byId.get('headroom')?.acceptance_gates?.paid_or_platform_semantic_canary_required, true);
  assert.equal(byId.get('markitdown')?.acceptance_gates?.paid_or_platform_semantic_canary_required, undefined);
});

test('strict runtime verifier recognizes paid/platform evidence but still requires owner approval', () => {
  const input = writeFixture('headroom-paid-structural.json', {
    schema_id: 'xlooop.external_capability_runtime_results.v1',
    results: [headroomStructuralResult()],
  });
  const semantic = writeFixture('headroom-paid-semantic.json', {
    schema_id: 'xlooop.headroom_semantic_canary.v1',
    status: 'PASS',
    evidence_kind: 'live_paid_or_platform_llm_semantic_canary',
    upstream_headroom_execution: true,
    provider_default_decision_authority: true,
    default_adoption_allowed: false,
    model: 'paid-model',
    evaluator: {
      lane: 'openai-compatible',
      provider_class: 'paid',
      endpoint_origin_sha256: 'a'.repeat(64),
      credential_material_present: false,
    },
    gates: {
      case_count: 40,
      token_reduction_pct: 58,
      original_task_correctness_pct: 100,
      task_correctness_pct: 100,
      answer_equivalence_pct: 100,
      citation_coverage_pct: 100,
      redaction_invariant_pct: 100,
      sensitive_leakage_count: 0,
      replayability_pct: 100,
    },
  });

  const result = runRuntimeVerifier(input, semantic);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some((check) => check.id === 'headroom_paid_or_platform_semantic_evidence_reviewed'));
  assert.ok(report.warnings.some((warning) => warning.id === 'headroom_owner_approval_and_feature_flag_required'));
  assert.ok(!report.warnings.some((warning) => warning.id === 'headroom_paid_or_platform_provider_canary_required'));
});

function headroomStructuralResult() {
  return {
    capability: 'headroom',
    default_adoption_allowed: false,
    answer_equivalence_measurement: 'structural_context_invariant_preservation_not_downstream_llm_semantics',
    gates: {
      token_reduction_pct: 58,
      answer_equivalence_pct: 100,
      citation_coverage_pct: 100,
      redaction_invariant_pct: 100,
      replayability_pct: 100,
      sensitive_leakage_count: 0,
      tenant_boundary_bypass_count: 0,
      external_graph_authority_count: 0,
      license_security_sbom_status: 'PASS',
    },
  };
}

function writeFixture(name, value) {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function runVerifier(input) {
  return spawnSync(
    process.execPath,
    ['scripts/verify-upstream-capability-sandbox-canary.mjs', '--format=json', `--live-input=${input}`],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

function runRuntimeVerifier(input, semantic = '') {
  const semanticArg = semantic ? [`--headroom-semantic-input=${semantic}`] : [];
  return spawnSync(
    process.execPath,
    ['scripts/verify-external-capability-runtime-results.mjs', '--strict', '--format=json', `--input=${input}`, ...semanticArg],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}
