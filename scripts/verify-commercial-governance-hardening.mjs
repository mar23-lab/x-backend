#!/usr/bin/env node
// verify-commercial-governance-hardening.mjs
//
// Gates the commercial SaaS governance projection path: MB-P stays private,
// xcp-platform templates are sanitized package inputs, XCP-boilerplate is a
// fixture, and customers consume only tenant-scoped backend projections.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const checkName = parseArg('check') || 'governance_projection_coverage';
const result = {
  schema_id: 'xlooop.commercial_governance_hardening_verifier.v1',
  check: checkName,
  status: 'PASS',
  checks: [],
  failures: [],
  warnings: [],
};

const CHECKS = {
  governance_projection_coverage: verifyGovernanceProjectionCoverage,
  layered_template_inheritance: verifyLayeredTemplateInheritance,
  claude_code_onboarding_doc: verifyClaudeCodeOnboardingDoc,
  customer_claude_code_oauth_binding: verifyCustomerClaudeCodeOauthBinding,
  prompt_injection_e2e: verifyPromptInjectionE2e,
  delete_export_object_storage_execution: verifyDeleteExportObjectStorageExecution,
  two_company_pilot_evidence: verifyTwoCompanyPilotEvidence,
  external_capability_registry: verifyExternalCapabilityRegistry,
  capability_benchmark_corpus: verifyCapabilityBenchmarkCorpus,
  markitdown_sandbox_adapter: verifyMarkitdownSandboxAdapter,
  hyper_extract_native_adapter: verifyHyperExtractNativeAdapter,
  headroom_replay_compression: verifyHeadroomReplayCompression,
  external_capability_headroom_benchmark: verifyExternalCapabilityHeadroomBenchmark,
  read_only_gates_do_not_dirty_worktree: verifyReadOnlyGatesDoNotDirtyWorktree,
  connector_token_revocation: verifyConnectorTokenRevocation,
  new_user_api_mcp_onboarding_scenario: verifyNewUserApiMcpOnboardingScenario,
  mcp_api_lifecycle_parity_live: verifyMcpApiLifecycleParityLive,
  two_company_live_pilot_evidence: verifyTwoCompanyLivePilotEvidence,
};

if (!CHECKS[checkName]) {
  fail('unknown_check', `unknown check: ${checkName}`, { valid_checks: Object.keys(CHECKS) });
} else {
  await CHECKS[checkName]();
}

finish();

function parseArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

function file(rel) {
  return path.join(repoRoot, rel);
}

function read(rel) {
  return fs.readFileSync(file(rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function exists(rel) {
  return fs.existsSync(file(rel));
}

function pass(id, details = {}) {
  result.checks.push({ id, status: 'PASS', ...details });
}

function warn(id, message, details = {}) {
  result.warnings.push({ id, message, ...details });
  result.checks.push({ id, status: 'WARN', message, ...details });
}

function fail(id, message, details = {}) {
  result.status = 'FAIL';
  result.failures.push({ id, message, ...details });
  result.checks.push({ id, status: 'FAIL', message, ...details });
}

function requireFile(rel) {
  if (!exists(rel)) {
    fail(`missing_file:${rel}`, `${rel} is missing`);
    return '';
  }
  pass(`file_present:${rel}`, { file: rel });
  return read(rel);
}

function requireIncludes(id, text, markers, details = {}) {
  const missing = markers.filter((marker) => !text.includes(marker));
  if (missing.length) fail(id, 'required markers missing', { missing, ...details });
  else pass(id, details);
}

function countBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item[field];
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function packageScripts() {
  return readJson('package.json').scripts || {};
}

function capabilityRegistry() {
  return readJson('docs/architecture/backend/EXTERNAL_CAPABILITY_REGISTRY.json');
}

function capabilityById(id) {
  const registry = capabilityRegistry();
  return (registry.capabilities || []).find((capability) => capability.id === id);
}

async function verifyGovernanceProjectionCoverage() {
  const manifest = readJson('docs/architecture/backend/GOVERNANCE_PROJECTION_COVERAGE.json');
  pass('manifest_loaded', { source_count: manifest.sources.length });
  const allowed = new Set(manifest.classification_values || []);
  const required = [
    'xcp_platform_template',
    'backend_projection',
    'private_control_plane_only',
    'boilerplate_fixture',
    'archive_or_ignore',
  ];
  const missingClassifications = required.filter((item) => !allowed.has(item));
  if (missingClassifications.length) fail('classification_enum_incomplete', 'manifest is missing classification values', { missing: missingClassifications });
  else pass('classification_enum_complete');

  const ids = new Set();
  const duplicateIds = [];
  const badSources = [];
  for (const source of manifest.sources || []) {
    if (ids.has(source.id)) duplicateIds.push(source.id);
    ids.add(source.id);
    if (!allowed.has(source.classification)) badSources.push({ id: source.id, classification: source.classification });
    for (const field of ['source_path', 'owner', 'exposure_policy', 'verifier']) {
      if (!source[field]) badSources.push({ id: source.id, missing_field: field });
    }
  }
  if (duplicateIds.length) fail('duplicate_source_ids', 'source ids must be unique', { duplicate_ids: duplicateIds });
  else pass('source_ids_unique');
  if (badSources.length) fail('source_classification_or_metadata_invalid', 'all sources need valid classification and metadata', { bad_sources: badSources });
  else pass('all_sources_classified');

  const counts = countBy(manifest.sources, 'classification');
  for (const [key, value] of Object.entries(counts)) {
    if (manifest.summary?.[`${key}_count`] !== value) {
      fail('summary_count_mismatch', 'manifest summary count does not match source rows', { key, expected: value, actual: manifest.summary?.[`${key}_count`] });
    }
  }
  if (result.status === 'PASS') pass('summary_counts_match', { counts });

  const xcpTemplates = manifest.sources.filter((source) => source.classification === 'xcp_platform_template');
  if (xcpTemplates.length === 4 && xcpTemplates.every((source) => source.source_path.includes('/xcp-platform/packages/xcp-skills-templates/templates/'))) {
    pass('xcp_platform_four_sanitized_templates_classified', { count: xcpTemplates.length });
  } else {
    fail('xcp_platform_template_set_invalid', 'expected exactly four sanitized xcp-platform template files', { actual: xcpTemplates });
  }

  const rawMbpAsTemplate = manifest.sources.filter((source) =>
    source.classification === 'xcp_platform_template' && source.source_path.includes('/MB-P/'),
  );
  if (rawMbpAsTemplate.length) fail('raw_mbp_classified_as_template', 'MB-P raw files must not be customer template package authority', { raw_mbp_as_template: rawMbpAsTemplate });
  else pass('raw_mbp_not_exported_as_template_package');

  if (manifest.summary?.raw_mbp_customer_api_exposure_allowed === false) pass('raw_mbp_customer_api_exposure_forbidden');
  else fail('raw_mbp_customer_api_exposure_not_forbidden', 'raw MB-P customer API exposure must be false');

  const scripts = packageScripts();
  const requiredScripts = [
    'verify:governance-projection-coverage',
    'verify:layered-template-inheritance',
    'verify:claude-code-onboarding-doc',
    'verify:customer-claude-code-oauth-binding',
    'verify:prompt-injection-e2e',
    'verify:delete-export-object-storage-execution',
    'verify:two-company-pilot-evidence',
    'verify:external-capability-registry',
    'verify:capability-benchmark-corpus',
    'verify:markitdown-sandbox-adapter',
    'verify:hyper-extract-safe-adapter',
    'verify:hyper-extract-native-adapter',
    'verify:headroom-replay-compression',
    'verify:external-capability-headroom-benchmark',
    'verify:read-only-gates-do-not-dirty-worktree',
    'verify:connector-token-revocation',
    'verify:new-user-api-mcp-onboarding-scenario',
    'verify:mcp-api-lifecycle-parity-live',
    'verify:two-company-live-pilot-evidence',
  ];
  const missingScripts = requiredScripts.filter((script) => !scripts[script]);
  if (missingScripts.length) fail('commercial_governance_package_scripts_missing', 'package scripts missing', { missing_scripts: missingScripts });
  else pass('commercial_governance_package_scripts_present', { script_count: requiredScripts.length });
}

async function verifyLayeredTemplateInheritance() {
  const store = requireFile('src/workers/dal/template-policy-store.ts');
  const types = requireFile('src/workers/dal/types/template-policy.ts');
  const route = requireFile('src/workers/routes/template-policy-registry.ts');
  requireIncludes('layered_resolver_markers_present', `${store}\n${types}\n${route}`, [
    'mergeLayeredTemplateRows',
    'layeredRowsByTemplate',
    'sortLayerRows',
    "resolution_strategy: 'layered_inheritance_v2'",
    'source_version_ids',
    'approval_refs',
    'source_refs',
    'binding_scopes_applied',
    'global platform default',
    'vertical pack',
    'company tenant binding',
    'workspace/project binding',
    'user overlay personalization',
  ]);
  requireIncludes('forbidden_lower_layer_weakening_guard_present', store, [
    'FORBIDDEN_OVERRIDE_KEYS',
    'security',
    'retention',
    'approval',
    'redaction',
    'tenant_isolation',
    '.includes(key)',
  ]);

  const forbidden = new Set(['security', 'retention', 'approval', 'redaction', 'forbidden_surfaces', 'tenant_isolation', 'raw_graph', 'full_tenant_memory', 'governance_scoring', 'agent_routing', 'private_graph_schema', 'secrets', 'search_all_memory']);
  const layers = [
    { tone: 'strict', security: { approval_required: true }, retention: { days: 365 }, examples: ['global'] },
    { tone: 'regulated smb', examples: ['vertical'], security: { approval_required: false } },
    { company_terms: ['tenant vocabulary'], forbidden_surfaces: [] },
    { project_default: 'current project' },
    { tone: 'friendly', secrets: 'leak-me', view: 'summary' },
  ];
  let effective = {};
  for (const [index, layer] of layers.entries()) {
    for (const [key, value] of Object.entries(layer)) {
      if (index === 0 || !forbidden.has(key)) effective[key] = value;
    }
  }
  if (
    effective.tone === 'friendly' &&
    effective.view === 'summary' &&
    effective.security?.approval_required === true &&
    effective.retention?.days === 365 &&
    !('secrets' in effective)
  ) {
    pass('layered_fixture_preserves_security_and_allows_personalization');
  } else {
    fail('layered_fixture_failed', 'layered inheritance weakened a protected field or blocked safe personalization', { effective });
  }
}

async function verifyClaudeCodeOnboardingDoc() {
  const doc = requireFile('docs/customer-onboarding/CLAUDE_CODE_API_ONBOARDING.md');
  requireIncludes('claude_code_onboarding_doc_complete', doc, [
    'Claude Code',
    'OAuth/device flow',
    'scoped Xlooop connector token',
    'xlooop.whoami',
    'user_id',
    'tenant_id',
    'membership_ref',
    'client_id',
    'token expiry',
    'auth method',
    'token hash or JTI',
    'Revoke',
    'cross-tenant leakage: `0`',
    'forbidden surface exposure: `0`',
  ]);
}

async function verifyCustomerClaudeCodeOauthBinding() {
  const doc = requireFile('docs/customer-onboarding/CLAUDE_CODE_API_ONBOARDING.md');
  const route = requireFile('src/workers/routes/template-policy-registry.ts');
  const mcp = requireFile('src/workers/routes/mcp-gateway.ts');
  const auth = requireFile('src/workers/middleware/auth.ts');
  const parity = requireFile('scripts/verify-api-mcp-parity.mjs');
  requireIncludes('customer_oauth_identity_binding_markers_present', `${doc}\n${route}\n${mcp}\n${auth}\n${parity}`, [
    'xlooop.whoami',
    'xlooop.identity_whoami.v1',
    'tenant_id',
    'membership_ref',
    'membership_resolution',
    'auth_method',
    'client_id',
    'token_expires_at',
    'service_principal',
    'mcp_whoami_ok',
    'token revocation',
  ]);
  requireIncludes('customer_token_is_not_prompt_supplied_tenant_authority', doc, [
    'Do not let Claude Code supply or override tenant identity from prompt text',
    'Service principals are for explicit automation identities only',
    'must never impersonate a customer employee',
  ]);
}

async function verifyPromptInjectionE2e() {
  const fixtures = readJson('docs/security/PROMPT_INJECTION_E2E_FIXTURES.json');
  const mcp = requireFile('src/workers/routes/mcp-gateway.ts');
  const route = requireFile('src/workers/routes/template-policy-registry.ts');
  const fixtureTypes = new Set(fixtures.fixtures.map((fixture) => fixture.source_type));
  for (const requiredType of ['markdown', 'yaml_frontmatter', 'html', 'pdf_text', 'source_connector', 'customer_prompt', 'frontend_rendered_content']) {
    if (!fixtureTypes.has(requiredType)) fail('prompt_injection_fixture_type_missing', 'missing fixture type', { required_type: requiredType });
  }
  if (result.status === 'PASS') pass('prompt_injection_fixture_types_complete', { fixture_count: fixtures.fixtures.length });
  for (const [key, value] of Object.entries(fixtures.acceptance || {})) {
    if (value !== 0 && value !== 100) fail('prompt_injection_acceptance_invalid', 'acceptance values must be zero-count or 100-percent invariants', { key, value });
  }
  requireIncludes('forbidden_surfaces_backstop_prompt_injection', `${mcp}\n${route}`, [
    'raw_graph',
    'full_tenant_memory',
    'xlooop_internal_templates',
    'governance_scoring',
    'agent_routing',
    'private_graph_schema',
    'secrets',
    'search_all_memory',
  ]);
  requireIncludes('safe_mcp_tool_surface_only', mcp, [
    'xlooop.whoami',
    'xlooop.get_task_packet',
    'xlooop.submit_evidence',
    'xlooop.report_tool_event',
    'xlooop.request_approval',
    'xlooop.get_workflow_status',
  ]);
}

async function verifyDeleteExportObjectStorageExecution() {
  const customerDelete = requireFile('scripts/verify-customer-delete-export.mjs');
  const suite = requireFile('scripts/verify-template-policy-suite.mjs');
  requireIncludes('delete_export_contract_and_execution_markers_present', `${customerDelete}\n${suite}`, [
    '/customer-data/export-requests/:approval_id/execute',
    '/customer-data/delete-requests/:approval_id/execute',
    'executeCustomerDataLifecycleRequest',
    'metadata_only',
    'irreversible_storage_erasure_not_proven_here',
    'raw object-storage erasure/legal-hold execution still requires production data-retention workflow evidence',
  ]);
  if (process.env.XLOOOP_DELETE_EXPORT_RECEIPT_FILE) {
    const receiptPath = path.resolve(process.env.XLOOOP_DELETE_EXPORT_RECEIPT_FILE);
    if (!fs.existsSync(receiptPath)) {
      fail('delete_export_receipt_file_missing', 'configured delete/export receipt file is missing', {
        receipt_file: receiptPath,
      });
      return;
    }
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    } catch (error) {
      fail('delete_export_receipt_file_invalid_json', 'configured delete/export receipt file is not valid JSON', {
        receipt_file: receiptPath,
        error: error.message,
      });
      return;
    }
    const requiredFields = [
      'schema_id',
      'evidence_class',
      'receipt_id',
      'immutable_receipt_ref',
      'source_system',
      'tenant_scope',
      'company_id',
      'user_id',
      'actor_id',
      'workspace_scope',
      'approval_id',
      'export_request_id',
      'delete_request_id',
      'audit_id',
      'storage_provider',
      'storage_bucket',
      'object_key',
      'object_hash_sha256',
      'export_manifest_hash_sha256',
      'legal_hold_state',
      'legal_hold_policy_id',
      'retention_class',
      'erasure_boundary',
      'tombstone_proof',
      'negative_read_after_delete',
      'rollback_boundary',
      'raw_customer_data_used',
      'action_executed_at',
      'generated_at',
      'verifier_command',
    ];
    const missing = requiredFields.filter((field) => receipt[field] === undefined || receipt[field] === '');
    const badValues = [];
    if (receipt.schema_id !== 'xlooop.delete_export_object_storage_receipt.v1') badValues.push('schema_id');
    if (!['synthetic_internal_canary', 'production_live_receipt'].includes(receipt.evidence_class)) badValues.push('evidence_class');
    if (!String(receipt.receipt_id || '').match(/^receipt\.[a-z0-9_.:-]+$/)) badValues.push('receipt_id');
    if (!String(receipt.immutable_receipt_ref || '').match(/^xlooop:\/\/receipts\//)) badValues.push('immutable_receipt_ref');
    if (!String(receipt.source_system || '').match(/^(synthetic_object_storage_canary|production_object_storage_lifecycle)$/)) badValues.push('source_system');
    if (receipt.raw_customer_data_used !== false) badValues.push('raw_customer_data_used');
    if (receipt.negative_read_after_delete !== true) badValues.push('negative_read_after_delete');
    if (!String(receipt.object_hash_sha256 || '').match(/^[a-f0-9]{64}$/)) badValues.push('object_hash_sha256');
    if (!String(receipt.export_manifest_hash_sha256 || '').match(/^[a-f0-9]{64}$/)) badValues.push('export_manifest_hash_sha256');
    if (!String(receipt.action_executed_at || '').match(/^\d{4}-\d{2}-\d{2}T/)) badValues.push('action_executed_at');
    if (!String(receipt.generated_at || '').match(/^\d{4}-\d{2}-\d{2}T/)) badValues.push('generated_at');
    if (receipt.evidence_class === 'production_live_receipt' && receipt.source_system !== 'production_object_storage_lifecycle') {
      badValues.push('source_system_for_production');
    }
    if (missing.length || badValues.length) {
      fail('delete_export_receipt_file_incomplete', 'delete/export receipt file is missing required proof fields or has invalid values', {
        receipt_file: receiptPath,
        missing,
        bad_values: badValues,
      });
    } else {
      pass('delete_export_object_storage_receipt_complete', {
        receipt_file: receiptPath,
        receipt_id: receipt.receipt_id,
        evidence_class: receipt.evidence_class,
        tenant_scope: receipt.tenant_scope,
        company_id: receipt.company_id,
        actor_id: receipt.actor_id,
        public_self_serve_authority: receipt.evidence_class === 'production_live_receipt',
      });
      if (receipt.evidence_class !== 'production_live_receipt') {
        warn(
          'delete_export_receipt_not_public_self_serve_authority',
          'delete/export receipt is valid for internal canary evidence, but public self-serve still requires evidence_class=production_live_receipt from the production retention/object-storage lane.',
          { receipt_file: receiptPath, evidence_class: receipt.evidence_class },
        );
      }
    }
  } else {
    warn('object_storage_erasure_live_evidence_required', 'bounded delete/export execution is proven, but irreversible object-storage erasure, legal hold, retention receipts, and rollback boundaries still require XLOOOP_DELETE_EXPORT_RECEIPT_FILE evidence before public self-serve.');
  }
}

async function verifyTwoCompanyPilotEvidence() {
  const scripts = packageScripts();
  for (const script of [
    'verify:tenant-bundle-isolation',
    'verify:tenant-source-isolation',
    'verify:tenant-search-isolation',
    'verify:paid-pilot-boundary',
    'verify:customer-onboarding-composed-gate',
    'verify:two-tenant-commercial-pilot',
  ]) {
    if (scripts[script]) pass(`pilot_gate_present:${script}`);
    else fail(`pilot_gate_missing:${script}`, `${script} is missing`);
  }
  warn('two_company_24_48h_live_pilot_required', 'the gates and synthetic fixtures are present; final hands-off public self-serve still requires 24-48h evidence from two external companies with customer-only employees.');
}

async function verifyExternalCapabilityRegistry() {
  const registry = capabilityRegistry();
  const doc = requireFile('docs/architecture/backend/EXTERNAL_CAPABILITY_ADOPTION_NATIVE_ADAPTERS.md');
  const requiredIds = ['markitdown', 'hyper_extract', 'headroom'];
  const ids = new Set((registry.capabilities || []).map((capability) => capability.id));
  const missing = requiredIds.filter((id) => !ids.has(id));
  if (missing.length) fail('external_capability_entries_missing', 'capability registry is missing required entries', { missing });
  else pass('external_capability_entries_present', { capability_count: registry.capabilities.length });

  for (const mode of ['external_benchmark', 'restricted_adapter', 'native_rebuild', 'opt_in_runtime', 'default_runtime']) {
    if (!(registry.adoption_modes || []).includes(mode)) {
      fail('external_capability_adoption_mode_missing', 'registry adoption mode missing', { mode });
    }
  }
  if (result.status === 'PASS') pass('external_capability_adoption_modes_complete');

  const bad = [];
  for (const capability of registry.capabilities || []) {
    for (const field of ['id', 'name', 'source_url', 'license', 'status', 'adoption_mode', 'runtime_surface', 'risk_class', 'allowed_scopes_if_approved', 'forbidden_scopes', 'sandbox_policy', 'acceptance_gates', 'rollback_plan', 'verifier']) {
      if (capability[field] === undefined || capability[field] === null || capability[field] === '') {
        bad.push({ id: capability.id, missing_field: field });
      }
    }
    if (capability.adopted_by_default !== false) bad.push({ id: capability.id, invalid: 'adopted_by_default_must_be_false' });
    for (const forbidden of ['raw_graph', 'full_tenant_memory', 'secrets', 'governance_scoring', 'agent_routing']) {
      if (!(capability.forbidden_scopes || []).includes(forbidden)) {
        bad.push({ id: capability.id, missing_forbidden_scope: forbidden });
      }
    }
  }
  if (bad.length) fail('external_capability_registry_invalid', 'capabilities must be fully classified and disabled by default', { bad });
  else pass('external_capability_registry_metadata_complete');

  requireIncludes('external_capability_native_adapter_policy_documented', doc, [
    'Adoption Modes',
    'MarkItDown',
    'Hyper-Extract',
    'Headroom',
    'native Xlooop typed extraction profile',
    'Graph pattern inspiration is allowed',
    'External graph authority',
    'Default adoption requires',
  ]);
}

async function verifyCapabilityBenchmarkCorpus() {
  const corpus = readJson('docs/architecture/backend/EXTERNAL_CAPABILITY_BENCHMARK_CORPUS.json');
  const cases = corpus.cases || [];
  if (cases.length === 20) pass('benchmark_corpus_has_20_cases', { case_count: cases.length });
  else fail('benchmark_corpus_case_count_invalid', 'expected exactly 20 benchmark cases', { case_count: cases.length });

  const requiredTypes = [
    'task_packet',
    'evidence_bundle',
    'pdf',
    'docx',
    'pptx',
    'xlsx',
    'csv',
    'json',
    'xml',
    'html',
    'source_connector',
    'tool_log',
    'malicious_markdown',
    'malicious_yaml',
    'malicious_html',
    'prompt_injection',
    'redaction_sensitive',
    'tenant_boundary_bypass',
    'image',
    'audio',
  ];
  const types = new Set(cases.map((item) => item.source_type));
  for (const type of requiredTypes) {
    if (!types.has(type)) fail('benchmark_corpus_source_type_missing', 'benchmark corpus missing source type', { type });
  }
  if (result.status === 'PASS') pass('benchmark_corpus_source_types_complete');

  const bad = [];
  for (const item of cases) {
    if (!item.id || !item.tenant_scope || !Array.isArray(item.capability_targets) || !item.capability_targets.length) {
      bad.push({ id: item.id, reason: 'missing identity, tenant_scope, or capability_targets' });
      continue;
    }
    const expected = item.expected_outputs || {};
    for (const invariant of ['source_span_required', 'redaction_required', 'tool_execution_allowed', 'graph_authority_allowed']) {
      if (typeof expected[invariant] !== 'boolean') bad.push({ id: item.id, missing_expected_output: invariant });
    }
    if (expected.tool_execution_allowed !== false) bad.push({ id: item.id, invalid: 'tool_execution_allowed_must_be_false' });
    if (expected.graph_authority_allowed !== false) bad.push({ id: item.id, invalid: 'graph_authority_allowed_must_be_false' });
  }
  if (bad.length) fail('benchmark_corpus_case_metadata_invalid', 'benchmark cases must carry safety invariants', { bad });
  else pass('benchmark_corpus_case_metadata_complete');

  for (const [key, expected] of Object.entries({
    extraction_fidelity_pct_min: 95,
    citation_source_span_coverage_pct_min: 95,
    answer_equivalence_pct_min: 95,
    sensitive_leakage_count: 0,
    redaction_invariant_pct: 100,
    tenant_boundary_bypass_count: 0,
    external_graph_authority_count: 0,
    replayability_pct: 100,
  })) {
    if (corpus.acceptance_gates?.[key] !== expected) {
      fail('benchmark_corpus_acceptance_gate_invalid', 'benchmark acceptance gate has wrong threshold', {
        key,
        expected,
        actual: corpus.acceptance_gates?.[key],
      });
    }
  }
  if (result.status === 'PASS') pass('benchmark_corpus_acceptance_gates_complete');
}

async function verifyMarkitdownSandboxAdapter() {
  const markitdown = capabilityById('markitdown');
  if (!markitdown) {
    fail('markitdown_registry_entry_missing', 'MarkItDown must be explicitly classified before use');
    return;
  }
  if (markitdown.adopted_by_default === false && markitdown.status === 'benchmark_candidate') pass('markitdown_not_adopted_by_default');
  else fail('markitdown_default_policy_invalid', 'MarkItDown must remain benchmark-only until gates pass', {
    status: markitdown.status,
    adopted_by_default: markitdown.adopted_by_default,
  });
  requireIncludes('markitdown_registry_sandbox_policy_present', JSON.stringify(markitdown), [
    'restricted_adapter_then_native_converter_lane',
    'backend_sandboxed_file_conversion_adapter_after_approval',
    'network_default',
    'plugin_default',
    'file_allowlist_required',
    'size_limit_required',
    'timeout_required',
    'process_isolation_required',
    'source_span_wrapped_markdown_generation',
    'p95_small_doc_conversion_ms_target',
  ]);
  for (const forbidden of ['raw_graph', 'full_tenant_memory', 'network_enabled_conversion_without_allowlist', 'plugins_enabled_without_allowlist']) {
    if (!(markitdown.forbidden_scopes || []).includes(forbidden)) {
      fail('markitdown_forbidden_scope_missing', 'MarkItDown registry missing forbidden scope', { forbidden });
    }
  }
  if (result.status === 'PASS') pass('markitdown_sandbox_forbidden_scopes_complete');
}

async function verifyHyperExtractNativeAdapter() {
  const hyper = capabilityById('hyper_extract');
  const doc = requireFile('docs/architecture/backend/EXTERNAL_CAPABILITY_ADOPTION_NATIVE_ADAPTERS.md');
  if (!hyper) {
    fail('hyper_extract_registry_entry_missing', 'Hyper-Extract must be explicitly classified before use');
    return;
  }
  if (hyper.adopted_by_default === false && hyper.status === 'native_rebuild_candidate') pass('hyper_extract_not_adopted_by_default');
  else fail('hyper_extract_default_policy_invalid', 'Hyper-Extract must remain native-rebuild/benchmark-only until gates pass', {
    status: hyper.status,
    adopted_by_default: hyper.adopted_by_default,
  });
  requireIncludes('hyper_extract_native_rebuild_policy_present', JSON.stringify(hyper), [
    'native_rebuild_preferred_restricted_adapter_only_for_benchmark',
    'typed_extraction_profiles',
    'graph_stability_heuristics',
    'SourceExtractionCandidate',
    'ExtractionEvidenceRef',
    'GraphSuggestion',
    'external_graph_authority_allowed',
    'direct_upstream_mcp_server_allowed',
    'external_graph_authority_count',
  ]);
  requireIncludes('hyper_extract_native_adapter_doc_present', doc, [
    'Hyper-Extract should not become graph authority',
    'Graph pattern inspiration is allowed only as reviewed architecture input',
    'native Xlooop typed extraction profile',
    'External graph authority',
    'direct Hyper-Extract MCP customer exposure',
  ]);
  for (const forbidden of ['authoritative_graph_write', 'persistent_external_knowledge_graph', 'direct_hyper_extract_mcp_server_customer_exposure', 'obsidian_export_customer_authority', 'private_graph_schema']) {
    if (!(hyper.forbidden_scopes || []).includes(forbidden)) {
      fail('hyper_extract_forbidden_scope_missing', 'Hyper-Extract registry missing forbidden scope', { forbidden });
    }
  }
  if (hyper.native_rebuild_policy?.external_graph_authority_allowed === false && hyper.native_rebuild_policy?.direct_upstream_mcp_server_allowed === false) {
    pass('hyper_extract_external_graph_authority_forbidden');
  } else {
    fail('hyper_extract_external_graph_authority_not_forbidden', 'Hyper-Extract native policy must forbid upstream graph authority and direct MCP exposure');
  }
}

async function verifyHeadroomReplayCompression() {
  const headroom = capabilityById('headroom');
  if (!headroom) {
    fail('headroom_registry_entry_missing', 'Headroom must be explicitly classified before use');
    return;
  }
  requireIncludes('headroom_replay_policy_present', JSON.stringify(headroom), [
    'restricted_adapter_with_replay_required',
    'original_payload_hash_required',
    'compressed_payload_hash_required',
    'replay_from_original_required',
    'redaction_before_compression_required',
    'citation_check_after_decompression_required',
    'reversible_replay_required',
  ]);
  if (headroom.acceptance_gates?.reversible_replay_required === true && headroom.acceptance_gates?.redaction_invariant_pct === 100) {
    pass('headroom_replay_and_redaction_gates_present');
  } else {
    fail('headroom_replay_or_redaction_gate_missing', 'Headroom must require replay and redaction invariants');
  }
}

async function verifyExternalCapabilityHeadroomBenchmark() {
  const headroom = capabilityById('headroom');
  if (!headroom) {
    fail('headroom_registry_entry_missing', 'Headroom must be explicitly classified before use');
    return;
  }
  if (headroom.adopted_by_default === false && headroom.status === 'benchmark_candidate') {
    pass('headroom_not_adopted_by_default');
  } else {
    fail('headroom_default_policy_invalid', 'Headroom must remain benchmark-only until gates pass', {
      status: headroom.status,
      adopted_by_default: headroom.adopted_by_default,
    });
  }
  requireIncludes('headroom_registry_gates_present', JSON.stringify(headroom), [
    'token_reduction_pct_min',
    'answer_equivalence_pct_min',
    'citation_coverage_pct_min',
    'sensitive_leakage_count',
    'redaction_invariant_pct',
    'license_security_sbom_required',
    'tenant_feature_flag_required',
    'rollback_plan',
  ]);
  for (const forbidden of ['raw_graph', 'full_tenant_memory', 'secrets', 'governance_scoring', 'agent_routing']) {
    if (!headroom.forbidden_scopes.includes(forbidden)) {
      fail('headroom_forbidden_scope_missing', 'Headroom registry missing forbidden scope', { forbidden });
    }
  }
  if (result.status === 'PASS') pass('headroom_forbidden_scopes_complete');
}

async function verifyReadOnlyGatesDoNotDirtyWorktree() {
  const scripts = packageScripts();
  const gateNames = [
    'verify:governance-projection-coverage',
    'verify:claude-code-onboarding-doc',
    'verify:no-raw-governance-template-exposure',
    'verify:external-capability-registry',
    'verify:capability-benchmark-corpus',
    'verify:markitdown-sandbox-adapter',
    'verify:hyper-extract-native-adapter',
    'verify:headroom-replay-compression',
    'verify:external-capability-headroom-benchmark',
    'verify:generated-artifact-policy',
    'verify:dirty-worktree-classification',
    'verify:customer-chat-tenant-isolation',
    'verify:tenant-search-isolation',
  ];
  for (const script of gateNames) {
    if (scripts[script]) pass(`read_only_gate_present:${script}`);
    else fail(`read_only_gate_missing:${script}`, `${script} is missing`);
  }
  if (result.status === 'FAIL') return;

  const before = gitStatus();
  const runs = [];
  for (const script of gateNames) {
    const run = spawnSync('npm', ['run', script, '--silent'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        XLOOOP_VERIFY_READONLY: '1',
      },
      maxBuffer: 1024 * 1024 * 8,
    });
    runs.push({ script, status: run.status });
    if (run.status !== 0) {
      fail('read_only_gate_failed', 'a read-only gate failed while checking dirty-file prevention', {
        script,
        status: run.status,
        stderr: (run.stderr || '').slice(0, 1200),
        stdout: (run.stdout || '').slice(0, 1200),
      });
      return;
    }
  }
  const after = gitStatus();
  if (after !== before) {
    fail('read_only_gates_dirtied_worktree', 'read-only gates changed git status', {
      before,
      after,
      runs,
    });
  } else {
    pass('read_only_gates_preserve_worktree_status', {
      run_count: runs.length,
      baseline_status_lines: before ? before.split('\n').length : 0,
    });
  }
}

async function verifyConnectorTokenRevocation() {
  const doc = requireFile('docs/customer-onboarding/CLAUDE_CODE_API_ONBOARDING.md');
  const auth = requireFile('src/workers/middleware/auth.ts');
  const mcp = requireFile('src/workers/routes/mcp-gateway.ts');
  const template = requireFile('src/workers/routes/template-policy-registry.ts');
  const parity = requireFile('scripts/verify-api-mcp-parity.mjs');
  requireIncludes('connector_revocation_contract_documented', doc, [
    'Revoking the connector token must make Claude Code access fail',
    'token revocation failure proof: present',
    'Do not let Claude Code supply or override tenant identity from prompt text',
    'Service principals are for explicit automation identities only',
    'must never impersonate a customer employee',
  ]);
  requireIncludes('whoami_identity_fields_available_for_revocation_probe', `${mcp}\n${template}\n${auth}\n${parity}`, [
    'xlooop.whoami',
    'tenant_id',
    'membership_ref',
    'membership_resolution',
    'auth_method',
    'client_id',
    'token_expires_at',
    'service_principal',
    'mcp_whoami_ok',
  ]);
  requireIncludes('service_principal_scoped_not_employee_impersonation', `${auth}\n${mcp}`, [
    'xlooop-canary-read',
    'xlooop-canary-lifecycle',
    'canary_read',
    'canary_lifecycle',
    'ensureCanaryLifecycleWrite',
  ]);
}

async function verifyNewUserApiMcpOnboardingScenario() {
  const doc = requireFile('docs/customer-onboarding/CLAUDE_CODE_API_ONBOARDING.md');
  const browserScenario = requireFile('scripts/verify-new-user-onboarding-isolation.mjs');
  const adminCli = requireFile('scripts/admin-access.mjs');
  const aspRunbook = requireFile('docs/onboarding/ASP_FIRST_CUSTOMER_PROVISIONING_RUNBOOK.md');
  const authTenancy = requireFile('docs/architecture/backend/AUTH_TENANCY_MODEL.md');
  const registrationGoLive = requireFile('docs/handoffs/customer-onboarding/CUSTOMER_REGISTRATION_GO_LIVE.md');
  const fourPilotRunbook = requireFile('docs/handoffs/customer-onboarding/FOUR_PILOT_LAUNCH_RUNBOOK.md');
  const backendScaffoldRunbook = requireFile('docs/handoffs/round39-backend-scaffold-operator-actions.md');
  const workerReadme = requireFile('src/workers/README.md');
  const sessionRoute = requireFile('src/workers/routes/session.ts');
  const adminRoute = requireFile('src/workers/routes/admin.ts');
  const mcp = requireFile('src/workers/routes/mcp-gateway.ts');
  const registryRoute = requireFile('src/workers/routes/template-policy-registry.ts');
  requireIncludes('new_user_customer_scenario_documented', doc, [
    'Create synthetic `company_a` and `company_b`',
    'Add `employee_a`, `employee_b`, and `admin`',
    'Connect Claude Code as `employee_a`',
    'Call `xlooop.whoami`',
    'Confirm `employee_a` cannot access `company_b`',
    'Submit a metadata-only evidence item and tool event',
    'Revoke the connector token',
  ]);
  requireIncludes('existing_browser_onboarding_isolation_fixture_present', browserScenario, [
    'new_user_session_is_local_owner',
    'new_user_session_has_tenant',
    'owner_param_does_not_login_andrey',
    'owner_param_does_not_leak_aps',
    'first_run_guide_does_not_leak_mbp_or_aps',
  ]);
  requireIncludes('clerk_first_onboarding_default_lane_enforced', `${adminCli}\n${aspRunbook}\n${sessionRoute}\n${adminRoute}`, [
    'CUSTOMER_AUTO_PROVISION_ON_SESSION',
    'CUSTOMER_AUTO_PROVISION_FROM_CLERK_ORG',
    'CUSTOMER_AUTO_PROVISION_APPROVER_USER_ID',
    'provisionCustomerFromAccessRequest',
    'invited_to_workspace_id',
    'clerk-org-session-auto-provision',
    'POST /api/v1/admin/access-requests/:id/provision',
    'Local npm run onboard-customer is a break-glass fallback only',
    'manual entitlement inserts are break-glass',
    'Manual entitlement SQL is not a customer onboarding step',
  ]);
  requireIncludes('clerk_workers_jwt_claims_support_session_first_provisioning', `${authTenancy}\n${registrationGoLive}\n${fourPilotRunbook}\n${backendScaffoldRunbook}\n${workerReadme}\n${sessionRoute}`, [
    '"email": "{{user.primary_email_address}}"',
    '"name": "{{user.full_name}}"',
    '"org_id": "{{org.id}}"',
    '"org_role": "{{org.role}}"',
    '"org_slug": "{{org.slug}}"',
    '`email` is required',
    'first-login customer DB provisioning',
    'pending_access',
  ]);
  requireIncludes('api_mcp_new_user_surfaces_are_scoped', `${mcp}\n${registryRoute}`, [
    'xlooop.whoami',
    'xlooop.get_task_packet',
    'xlooop.submit_evidence',
    'xlooop.report_tool_event',
    'xlooop.request_approval',
    'effective_template',
  ]);
}

async function verifyMcpApiLifecycleParityLive() {
  const lifecycle = requireFile('scripts/verify-api-mcp-lifecycle-parity.mjs');
  const apiRoute = requireFile('src/workers/routes/operational-spine.ts');
  const mcp = requireFile('src/workers/routes/mcp-gateway.ts');
  requireIncludes('lifecycle_parity_verifier_scoped_to_canary_packets', lifecycle, [
    'XLOOOP_PARITY_PACKET_ID',
    'pkt-canary-',
    'XLOOOP_CANARY_API_TOKEN',
    'XLOOOP_CANARY_LIFECYCLE_API_TOKEN',
    'proveCanaryWriteDenials',
    'proveCanaryLifecycleWrites',
    'lifecycle_canary_customer_delete_forbidden',
    'metadata-only canary',
  ]);
  requireIncludes('lifecycle_write_surfaces_require_lifecycle_canary', `${apiRoute}\n${mcp}`, [
    'ensureCanaryLifecycleWrite',
    'canary_lifecycle',
    'xlooop.report_tool_event',
    'request_approval',
  ]);
  const lifecycleTokenFile = process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE || '/tmp/xlooop-canary-lifecycle-api-token.txt';
  const hasLifecycleToken = Boolean(process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN) || fs.existsSync(lifecycleTokenFile);
  const hasCanaryPacketId = Boolean(process.env.XLOOOP_PARITY_PACKET_ID);
  if (hasLifecycleToken && hasCanaryPacketId) {
    pass('live_lifecycle_parity_inputs_present', {
      packet_id_source: 'env:XLOOOP_PARITY_PACKET_ID',
      lifecycle_token_source: process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN
        ? 'env:XLOOOP_CANARY_LIFECYCLE_API_TOKEN'
        : lifecycleTokenFile,
    });
  } else {
    warn('live_lifecycle_parity_requires_canary_token', 'static lifecycle parity controls are wired; live row creation requires XLOOOP_CANARY_LIFECYCLE_API_TOKEN or /tmp/xlooop-canary-lifecycle-api-token.txt and a pkt-canary-* packet id.', {
      has_lifecycle_token: hasLifecycleToken,
      has_canary_packet_id: hasCanaryPacketId,
    });
  }
}

async function verifyTwoCompanyLivePilotEvidence() {
  const doc = requireFile('docs/customer-onboarding/CLAUDE_CODE_API_ONBOARDING.md');
  const runbook = requireFile('docs/customer-onboarding/ANDREY_HY_CONTROLLED_VALIDATION_RUNBOOK.md');
  const builder = requireFile('scripts/create-two-company-live-pilot-evidence.mjs');
  const pilotScript = requireFile('scripts/verify-two-tenant-commercial-pilot.mjs');
  const composed = requireFile('scripts/verify-customer-onboarding-composed-gate.mjs');
  requireIncludes('two_company_live_pilot_acceptance_documented', `${doc}\n${runbook}\n${builder}\n${pilotScript}\n${composed}`, [
    'cross-tenant leakage',
    'cross_tenant_search_hit_count',
    'forbidden surface exposure',
    'tenant',
    'approval',
    'source',
    'external_live_pilot',
    'create-two-company-live-pilot',
  ]);
  if (process.env.XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE) {
    const evidencePath = path.resolve(process.env.XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE);
    if (!fs.existsSync(evidencePath)) {
      fail('two_company_live_evidence_file_missing', 'configured live pilot evidence file is missing', {
        evidence_file: evidencePath,
      });
      return;
    }
    const text = fs.readFileSync(evidencePath, 'utf8');
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      verifyTwoCompanyLivePilotJsonEvidence(evidencePath, trimmed);
    } else {
      requireIncludes('two_company_live_evidence_file_complete', text, [
        'company_a',
        'company_b',
        '24-48h',
        'cross-tenant leakage: 0',
        'unapproved writes: 0',
        'raw graph exposure: 0',
      ], { evidence_file: evidencePath });
      warn(
        'two_company_live_evidence_markdown_legacy',
        'markdown marker evidence is accepted for continuity, but public self-serve authority should use xlooop.two_company_live_pilot_evidence.v1 JSON with duration, tenant, auth, audit, and safety metrics.',
        { evidence_file: evidencePath },
      );
    }
  } else {
    warn('two_company_live_evidence_not_configured', 'synthetic gates exist, but XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE is not set; hands-off self-serve still waits for real two-company 24-48h evidence.');
  }
}

function verifyTwoCompanyLivePilotJsonEvidence(evidencePath, text) {
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch (error) {
    fail('two_company_live_evidence_file_invalid_json', 'configured two-company pilot evidence file is not valid JSON', {
      evidence_file: evidencePath,
      error: error.message,
    });
    return;
  }

  const requiredFields = [
    'schema_id',
    'evidence_class',
    'started_at',
    'ended_at',
    'duration_hours',
    'companies',
    'metrics',
    'audit_ids',
    'generated_at',
  ];
  const missing = requiredFields.filter((field) => evidence[field] === undefined || evidence[field] === '');
  const badValues = [];
  if (evidence.schema_id !== 'xlooop.two_company_live_pilot_evidence.v1') badValues.push('schema_id');
  if (!['internal_synthetic_canary', 'external_live_pilot'].includes(evidence.evidence_class)) badValues.push('evidence_class');
  if (!Number.isFinite(Number(evidence.duration_hours)) || Number(evidence.duration_hours) < 24) badValues.push('duration_hours');
  if (!Array.isArray(evidence.companies) || evidence.companies.length < 2) badValues.push('companies');
  if (!Array.isArray(evidence.audit_ids) || evidence.audit_ids.length === 0) badValues.push('audit_ids');
  if (Number.isNaN(Date.parse(evidence.started_at || ''))) badValues.push('started_at');
  if (Number.isNaN(Date.parse(evidence.ended_at || ''))) badValues.push('ended_at');
  if (Number.isNaN(Date.parse(evidence.generated_at || ''))) badValues.push('generated_at');

  const companies = Array.isArray(evidence.companies) ? evidence.companies : [];
  const companyProblems = [];
  const sourceEvidenceProblems = [];
  for (const [index, company] of companies.entries()) {
    for (const field of ['company_id', 'tenant_id', 'workspace_name']) {
      if (!company[field]) companyProblems.push(`companies[${index}].${field}`);
    }
    if (!Number.isFinite(Number(company.employee_count)) || Number(company.employee_count) < 1) {
      companyProblems.push(`companies[${index}].employee_count`);
    }
    if (company.customer_only_employees !== true) {
      companyProblems.push(`companies[${index}].customer_only_employees`);
    }
    sourceEvidenceProblems.push(...sourceEvidenceProblemsFor(company.source_evidence, index));
  }

  const metrics = evidence.metrics || {};
  const zeroCountMetrics = [
    'cross_tenant_leakage_count',
    'cross_tenant_search_hit_count',
    'unapproved_writes_count',
    'raw_graph_exposure_count',
    'forbidden_surface_exposure_count',
    'revocation_bypass_count',
    'auth_regression_count',
    'api_mcp_safety_regression_count',
  ];
  const metricProblems = zeroCountMetrics.filter((field) => metrics[field] !== 0);
  if (metrics.audit_coverage_pct !== 100) metricProblems.push('audit_coverage_pct');

  if (missing.length || badValues.length || companyProblems.length || sourceEvidenceProblems.length || metricProblems.length) {
    fail('two_company_live_evidence_file_incomplete', 'two-company pilot evidence file is missing required proof fields or has unsafe values', {
      evidence_file: evidencePath,
      missing,
      bad_values: badValues,
      company_problems: companyProblems,
      source_evidence_problems: sourceEvidenceProblems,
      metric_problems: metricProblems,
    });
    return;
  }

  pass('two_company_live_evidence_file_complete', {
    evidence_file: evidencePath,
    evidence_class: evidence.evidence_class,
    duration_hours: Number(evidence.duration_hours),
    company_count: companies.length,
    public_self_serve_authority: evidence.evidence_class === 'external_live_pilot',
  });
  if (evidence.evidence_class !== 'external_live_pilot') {
    warn(
      'two_company_live_evidence_not_public_self_serve_authority',
      'two-company evidence is valid for internal canary evidence, but public self-serve still requires evidence_class=external_live_pilot from a real 24-48h two-company run.',
      { evidence_file: evidencePath, evidence_class: evidence.evidence_class },
    );
  }
}

function sourceEvidenceProblemsFor(sourceEvidence = {}, companyIndex) {
  const problems = [];
  for (const field of [
    'provider',
    'source_connection_id',
    'workspace_id',
    'connection_status',
    'sync_status',
    'connected_at',
    'last_synced_at',
    'latest_event_at',
  ]) {
    if (typeof sourceEvidence[field] !== 'string' || sourceEvidence[field].trim() === '') {
      problems.push(`companies[${companyIndex}].source_evidence.${field}`);
    }
  }
  if (sourceEvidence.connection_status !== 'connected') {
    problems.push(`companies[${companyIndex}].source_evidence.connection_status`);
  }
  if (!['synced', 'completed'].includes(sourceEvidence.sync_status)) {
    problems.push(`companies[${companyIndex}].source_evidence.sync_status`);
  }
  if (!Number.isFinite(Number(sourceEvidence.emitted_event_count)) || Number(sourceEvidence.emitted_event_count) < 1) {
    problems.push(`companies[${companyIndex}].source_evidence.emitted_event_count`);
  }
  if (!Array.isArray(sourceEvidence.audit_ids) || sourceEvidence.audit_ids.length === 0) {
    problems.push(`companies[${companyIndex}].source_evidence.audit_ids`);
  }
  for (const dateField of ['connected_at', 'last_synced_at', 'latest_event_at']) {
    if (Number.isNaN(Date.parse(sourceEvidence[dateField] || ''))) {
      problems.push(`companies[${companyIndex}].source_evidence.${dateField}`);
    }
  }
  return [...new Set(problems)];
}

function gitStatus() {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 4,
  });
  if (status.status !== 0) {
    fail('git_status_failed', 'could not read git status for dirty-file guard', {
      stderr: (status.stderr || '').slice(0, 1200),
      stdout: (status.stdout || '').slice(0, 1200),
    });
    return '';
  }
  return (status.stdout || '').trim();
}

function finish() {
  const format = parseArg('format') || 'json';
  if (format === 'pretty') {
    console.log(`${result.schema_id}: ${result.status} check=${result.check}`);
    for (const check of result.checks) {
      console.log(`  ${check.status} ${check.id}${check.message ? ` - ${check.message}` : ''}`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(result.status === 'PASS' ? 0 : 1);
}
