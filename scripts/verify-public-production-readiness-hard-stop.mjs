#!/usr/bin/env node
// Composed hard-stop for public/self-serve production claims. It passes when
// internal posture is safe and public production remains blocked honestly;
// it grants public authority only when every live-production gate passes.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const checks = [];
const failures = [];
const warnings = [];
const strictPublic = process.argv.includes('--strict-public') || process.env.XLOOOP_REQUIRE_PUBLIC_SELF_SERVE === '1';

if (process.argv.includes('--self-test')) {
  const result = authorityPostureSelfTest();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'PASS' ? 0 : 1);
}

function run(id, command, args, options = {}) {
  const proc = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 1024 * 1024 * 12, env: process.env });
  const parsed = parseLastJson(proc.stdout || '');
  const authority = options.authorityField ? parsed?.[options.authorityField] === true : proc.status === 0;
  const row = { id, status: proc.status === 0 ? 'PASS' : 'FAIL', exit_code: proc.status, stdout_tail: (proc.stdout || '').slice(-1800), stderr_tail: (proc.stderr || '').slice(-1800), required_for_public: options.requiredForPublic === true };
  try {
    row.summary = {
      schema_id: parsed.schema_id,
      status: parsed.status,
      public_self_serve_authority: parsed.public_self_serve_authority,
      external_capability_default_authority: parsed.external_capability_default_authority,
      internal_controlled_canary_authority: parsed.internal_controlled_canary_authority,
      api_mcp_live_canary_authority: parsed.api_mcp_live_canary_authority,
      internal_static_boundary_authority: parsed.internal_static_boundary_authority,
      public_production_authority: parsed.public_production_authority,
      production_db_live_authority: parsed.production_db_live_authority,
      strict_public_inputs_ready: parsed.strict_public_inputs_ready,
      lane_readiness: parsed.lane_readiness,
    };
  } catch {
    // Human-oriented verifier output is still captured in stdout_tail.
  }
  if (options.authorityField) {
    row.authority = authority;
    row.authority_field = options.authorityField;
  }
  checks.push(row);
  if (proc.status !== 0 && options.blockInternal) failures.push(row);
  if (!authority && options.requiredForPublic) warnings.push({ id: `${id}_public_authority_absent`, message: options.message || 'Required public/self-serve production authority evidence is absent.' });
  if (proc.status !== 0 && options.message && options.requiredForPublic !== true) warnings.push({ id: `${id}_advisory_gap`, message: options.message });
  return row;
}

run('hosted_ci_runner_health', 'npm', ['run', '--silent', 'verify:hosted-ci-runner-health'], {
  blockInternal: false,
  requiredForPublic: false,
  message: 'Hosted CI runner evidence is classified for transparency. Xlooop release authority remains the local gate stack while workflows are disabled/non-authoritative.',
});
run('feedback_annotations', 'npm', ['run', '--silent', 'verify:feedback-annotations'], { blockInternal: true });
run('customer_feedback_tools_hardening', 'npm', ['run', '--silent', 'verify:customer-feedback-tools-hardening'], { blockInternal: true });
run('customer_api_access_guidance', 'npm', ['run', '--silent', 'verify:customer-api-access-guidance'], { blockInternal: true });
run('cloud_deployment_readiness', 'npm', ['run', '--silent', 'verify:cloud-deployment-readiness'], { blockInternal: true });
run('cloudflare_deployment_signal', 'npm', ['run', '--silent', 'verify:cloudflare-deployment-signal'], { blockInternal: true });
run('hosted_deployment_evidence', 'npm', ['run', '--silent', 'verify:hosted-deployment-evidence'], {
  blockInternal: false,
  requiredForPublic: false,
  message: 'Hosted deployment manifest freshness is build/deploy evidence; branch-local public hard-stop authority is carried by cloud readiness, hosted CI runner-health, and production receipt gates.',
});
run('live_authority_inputs', 'npm', ['run', '--silent', 'verify:live-authority-inputs'], {
  blockInternal: false,
  requiredForPublic: false,
  authorityField: 'strict_public_inputs_ready',
  message: 'Live authority input preflight is incomplete; configure the missing files, packet id, tokens, and DB URLs before running strict public authority gates.',
});
run('external_capability_registry', 'npm', ['run', '--silent', 'verify:external-capability-registry'], { blockInternal: true });
run('upstream_capability_live_canary', 'npm', ['run', '--silent', 'verify:upstream-capability-live-canary'], {
  blockInternal: false,
  message: 'Upstream capability canary failures block default-enabling external tools, but do not block public onboarding while every external capability remains disabled by default.',
});
run('external_capability_runtime_results', 'npm', ['run', '--silent', 'verify:external-capability-runtime-results'], { blockInternal: true });
run('external_capability_default_hard_stop', 'npm', ['run', '--silent', 'verify:external-capability-default-hard-stop'], { blockInternal: true, authorityField: 'external_capability_default_authority', message: 'Provide live upstream canary and strict runtime benchmark evidence before default-enabling external capabilities.' });
run('api_mcp_live_canary_hard_stop', 'npm', ['run', '--silent', 'verify:api-mcp-live-canary-hard-stop', '--', '--strict-live', '--target=production'], { blockInternal: true, requiredForPublic: true, authorityField: 'api_mcp_live_canary_authority', message: 'Set XLOOOP_PARITY_PACKET_ID and scoped canary read/lifecycle tokens before API/MCP live authority.' });
run('two_company_live_pilot_evidence', 'npm', [
  'run',
  '--silent',
  'verify:two-company-live-pilot-evidence',
  ...(strictPublic ? ['--', '--strict-live'] : []),
], { blockInternal: true, requiredForPublic: true, authorityField: 'two_company_live_pilot_authority', message: 'Set XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE to a real 24-48h external_live_pilot evidence packet; existing APS/H&Y account usage counts only after it is source-linked in that packet.' });
run('production_db_live_authority', 'npm', ['run', '--silent', 'verify:production-db-live-authority', '--', '--strict-live-db'], { blockInternal: true, requiredForPublic: true, authorityField: 'production_db_live_authority', message: 'Set DATABASE_URL and XLOOOP_RLS_APP_DATABASE_URL to prove production migrations and app-role RLS before public/customer onboarding.' });
run('live_evidence_authority_matrix', 'npm', ['run', '--silent', 'verify:live-evidence-authority-matrix'], { blockInternal: true, requiredForPublic: true, authorityField: 'public_production_authority', message: 'Every live evidence lane must report authority=true before public/customer onboarding resumes.' });
run('delete_export_object_storage_execution', 'npm', ['run', '--silent', 'verify:delete-export-object-storage-execution'], { blockInternal: true });
run('public_self_serve_production_receipts', 'npm', ['run', '--silent', 'verify:public-self-serve-production-receipts'], { blockInternal: strictPublic, requiredForPublic: true, authorityField: 'public_self_serve_authority', message: 'Set XLOOOP_DELETE_EXPORT_RECEIPT_FILE to a production_live_receipt before public/self-serve enablement.' });

const publicAuthority = checks.find((row) => row.id === 'public_self_serve_production_receipts')?.authority === true;
const externalCapabilityRow = checks.find((row) => row.id === 'external_capability_default_hard_stop');
const externalDefaultAuthority = externalCapabilityRow?.authority === true;
const externalNonDefaultAuthority = externalCapabilityRow?.status === 'PASS' && externalCapabilityRow?.summary?.internal_controlled_canary_authority === true;
const externalCapabilityPublicAuthority = externalDefaultAuthority || externalNonDefaultAuthority;
const apiMcpLiveAuthority = checks.find((row) => row.id === 'api_mcp_live_canary_hard_stop')?.authority === true;
const twoCompanyAuthority = checks.find((row) => row.id === 'two_company_live_pilot_evidence')?.authority === true;
const productionDbAuthority = checks.find((row) => row.id === 'production_db_live_authority')?.authority === true;
const liveEvidenceAuthority = checks.find((row) => row.id === 'live_evidence_authority_matrix')?.authority === true;
const publicLaneIds = new Set([
  'api_mcp_live_canary_hard_stop',
  'two_company_live_pilot_evidence',
  'production_db_live_authority',
  'live_evidence_authority_matrix',
  'public_self_serve_production_receipts',
]);
const internalSafetyFailures = failures.filter((row) => !publicLaneIds.has(row.id));
const internalControlledValidationAuthority = deriveInternalControlledValidationAuthority(
  internalSafetyFailures.length,
  externalCapabilityPublicAuthority,
);
const blockedAuthorityLanes = [
  publicAuthority ? null : 'public/self-serve delete-export-legal-hold receipt',
  externalCapabilityPublicAuthority ? null : 'external capability safe non-default posture',
  apiMcpLiveAuthority ? null : 'API/MCP live canary',
  twoCompanyAuthority ? null : 'two-company pilot evidence',
  productionDbAuthority ? null : 'production DB/RLS',
].filter(Boolean);
const publicProductionAuthority = derivePublicProductionAuthority({
  publicAuthority,
  externalCapabilityPublicAuthority,
  apiMcpLiveAuthority,
  twoCompanyAuthority,
  productionDbAuthority,
  liveEvidenceAuthority,
});
if (strictPublic && !publicProductionAuthority && !failures.some((row) => row.id === 'strict_public_authority_blocked')) {
  failures.push({
    id: 'strict_public_authority_blocked',
    status: 'FAIL',
    blocked_authority_lanes: blockedAuthorityLanes,
    message: 'Strict public readiness requires every public authority lane to pass.',
  });
}
const status = deriveVerifierStatus(failures.length, strictPublic, publicProductionAuthority);
const report = {
  schema_id: 'xlooop.public_production_readiness_hard_stop.verifier.v1',
  status,
  strict_public: strictPublic,
  public_self_serve_authority: publicAuthority,
  external_capability_default_authority: externalDefaultAuthority,
  external_capability_public_non_default_authority: externalNonDefaultAuthority,
  external_capability_public_authority: externalCapabilityPublicAuthority,
  api_mcp_live_canary_authority: apiMcpLiveAuthority,
  two_company_live_pilot_authority: twoCompanyAuthority,
  production_db_live_authority: productionDbAuthority,
  public_production_authority: publicProductionAuthority,
  live_evidence_authority: liveEvidenceAuthority,
  internal_controlled_validation_authority: internalControlledValidationAuthority,
  internal_safety_failure_count: internalSafetyFailures.length,
  checks,
  failures,
  warnings,
  blocked_authority_lanes: blockedAuthorityLanes,
  conclusion: publicProductionAuthority
    ? 'Public/self-serve production, external capability safe posture, API/MCP live-canary, two-company pilot, and production DB authority are present.'
    : `Internal controlled validation may continue. Public production remains blocked by: ${blockedAuthorityLanes.join(', ')}.`
};
console.log(JSON.stringify(report, null, 2));
process.exit(status === 'PASS' ? 0 : 1);

function deriveInternalControlledValidationAuthority(internalSafetyFailureCount, externalCapabilityAuthority) {
  return internalSafetyFailureCount === 0 && externalCapabilityAuthority === true;
}

function derivePublicProductionAuthority(authority) {
  return Object.values(authority).every((value) => value === true);
}

function deriveVerifierStatus(failureCount, strict, publicProductionAuthority) {
  return failureCount > 0 || (strict && !publicProductionAuthority) ? 'FAIL' : 'PASS';
}

function authorityPostureSelfTest() {
  const internalCases = [
    { id: 'internal_green_before_public_receipt', failure_count: 0, external_authority: true, public_authority: false, expected: true },
    { id: 'internal_stays_green_after_public_receipt', failure_count: 0, external_authority: true, public_authority: true, expected: true },
    { id: 'internal_failure_blocks_internal_authority', failure_count: 1, external_authority: true, public_authority: false, expected: false },
    { id: 'unsafe_external_posture_blocks_internal_authority', failure_count: 0, external_authority: false, public_authority: false, expected: false },
  ].map((testCase) => {
    const actual = deriveInternalControlledValidationAuthority(testCase.failure_count, testCase.external_authority);
    return {
      id: testCase.id,
      status: actual === testCase.expected ? 'PASS' : 'FAIL',
      public_authority: testCase.public_authority,
      expected: testCase.expected,
      actual,
    };
  });
  const publicCases = [
    { id: 'all_public_lanes_grant_authority', lanes: [true, true, true, true, true, true], expected: true },
    { id: 'missing_two_company_lane_blocks_authority', lanes: [true, true, true, false, true, false], expected: false },
  ].map((testCase) => {
    const actual = derivePublicProductionAuthority(Object.fromEntries(testCase.lanes.map((value, index) => [index, value])));
    return { id: testCase.id, status: actual === testCase.expected ? 'PASS' : 'FAIL', expected: testCase.expected, actual };
  });
  const exitCases = [
    { id: 'advisory_mode_preserves_internal_validation', failure_count: 0, strict: false, public_authority: false, expected: 'PASS' },
    { id: 'strict_mode_fails_without_public_authority', failure_count: 0, strict: true, public_authority: false, expected: 'FAIL' },
    { id: 'strict_mode_passes_with_public_authority', failure_count: 0, strict: true, public_authority: true, expected: 'PASS' },
  ].map((testCase) => {
    const actual = deriveVerifierStatus(testCase.failure_count, testCase.strict, testCase.public_authority);
    return { id: testCase.id, status: actual === testCase.expected ? 'PASS' : 'FAIL', expected: testCase.expected, actual };
  });
  const cases = [...internalCases, ...publicCases, ...exitCases];
  return {
    schema_id: 'xlooop.public_production_readiness_hard_stop.self_test.v1',
    status: cases.every((testCase) => testCase.status === 'PASS') ? 'PASS' : 'FAIL',
    checks: cases,
  };
}

function parseLastJson(text) {
  if (!text) return {};
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to tail extraction for mixed human + JSON output.
    }
  }
  const start = text.lastIndexOf('\n{');
  const candidate = start >= 0 ? text.slice(start + 1) : text.slice(text.indexOf('{'));
  if (!candidate || !candidate.trim().startsWith('{')) return {};
  try {
    return JSON.parse(candidate);
  } catch {
    return {};
  }
}
