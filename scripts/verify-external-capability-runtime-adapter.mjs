#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const failures = [];
const checks = [];

function requireCheck(id, condition, evidence) {
  checks.push({ id, status: condition ? 'PASS' : 'FAIL', evidence });
  if (!condition) failures.push(id);
}

const pkg = JSON.parse(read('package.json'));
const production = read('wrangler.toml');
const pilot = read('wrangler.pilot-shadow.toml');
const capabilityConfig = read('wrangler.capability-adapter.toml');
const dockerfile = read('Dockerfile.capabilities');
const worker = read('src/capability-worker/index.ts');
const runner = read('src/capability-worker/external-capability-runner.py');
const client = read('src/workers/services/external-capability-adapter.ts');
const documents = read('src/workers/routes/documents.ts');
const documentStore = read('src/workers/dal/document-store.ts');
const chat = read('src/workers/services/cockpit-chat.ts');
const registry = JSON.parse(read('docs/architecture/backend/EXTERNAL_CAPABILITY_REGISTRY.json'));
const policy = read('docs/architecture/backend/EXTERNAL_CAPABILITY_ADOPTION_NATIVE_ADAPTERS.md');

const sandboxVersion = pkg.dependencies?.['@cloudflare/sandbox'];
requireCheck('sandbox_sdk_pinned', /^\d+\.\d+\.\d+$/.test(sandboxVersion || ''), { sandboxVersion });
requireCheck(
  'sandbox_image_sdk_parity',
  dockerfile.includes(`cloudflare/sandbox:${sandboxVersion}-python`),
  { sandboxVersion },
);
requireCheck('external_packages_pinned', (
  dockerfile.includes('python3 -m pip install --no-cache-dir')
  && dockerfile.includes('markitdown[docx,pptx,xlsx]==0.1.7')
  && dockerfile.includes('headroom-ai==0.34.0')
), null);
requireCheck('runtime_tokenizer_cache_baked', (
  dockerfile.includes('TIKTOKEN_CACHE_DIR=/opt/xlooop/tiktoken-cache')
  && worker.includes('TIKTOKEN_CACHE_DIR=/opt/xlooop/tiktoken-cache')
), null);
requireCheck('private_adapter_not_public', (
  capabilityConfig.includes('workers_dev = false')
  && capabilityConfig.includes('preview_urls = false')
  && !/(^|\n)routes\s*=|\[\[routes\]\]/m.test(capabilityConfig)
), null);
requireCheck('sandbox_no_egress', worker.includes('enableInternet = false'), null);
requireCheck('sandbox_request_isolation', (
  worker.includes('crypto.randomUUID()') && worker.includes('await sandbox.destroy()')
), null);
requireCheck('path_bound_operations', (
  worker.includes("'markitdown.convert'")
  && worker.includes("'headroom.compress'")
  && runner.includes('operation == "markitdown.convert"')
  && runner.includes('operation == "headroom.compress"')
), null);
requireCheck('plugins_disabled', runner.includes('MarkItDown(enable_plugins=False)'), null);
requireCheck('source_hash_verified_in_sandbox', runner.includes('raise ValueError("source hash mismatch")'), null);

requireCheck('production_binding_declared', (
  production.includes('binding = "EXTERNAL_CAPABILITY_ADAPTER"')
  && production.includes('service = "xlooop-capability-adapter"')
), null);
requireCheck('pilot_binding_isolated', (
  pilot.includes('binding = "EXTERNAL_CAPABILITY_ADAPTER"')
  && pilot.includes('service = "xlooop-capability-adapter-pilot-shadow"')
), null);
for (const [id, config] of [['production', production], ['pilot', pilot]]) {
  requireCheck(`${id}_defaults_disabled`, (
    config.includes('MARKITDOWN_ADAPTER_ENABLED = "false"')
    && config.includes('HEADROOM_COMPRESSION_ENABLED = "false"')
    && config.includes('EXTERNAL_CAPABILITY_TENANT_REFS = ""')
  ), null);
}

requireCheck('tenant_allowlist_required', (
  client.includes('EXTERNAL_CAPABILITY_TENANT_REFS')
  && client.includes('configuredTenantRefs')
  && client.includes('tenantCapabilityEnabled')
), null);

requireCheck('tenant_identifier_minimized', (
  client.includes('tenantRef(input.workspace_id)')
  && client.includes("hashText(`xlooop-tenant:${workspaceId}`)")
), null);
requireCheck('api_revalidates_receipt_hashes', (
  client.includes('result.receipt.output_hash !== outputHash')
  && client.includes('result.receipt.source_hash !== input.source_hash')
  && client.includes('result.receipt.source_hash !== originalHash')
), null);
requireCheck('markitdown_provenance_granularity_honest', (
  client.includes("span_kind: 'normalized_output_span'")
  && client.includes("provenance_level: 'document'")
  && runner.includes('"span_kind": "normalized_output_span"')
  && runner.includes('"provenance_level": "document"')
), null);
requireCheck('headroom_per_request_reduction_gate', (
  client.includes('MIN_HEADROOM_REDUCTION_PCT = 25')
  && client.includes('result.receipt.token_reduction_pct < MIN_HEADROOM_REDUCTION_PCT')
), null);
requireCheck('headroom_per_request_semantic_guard', (
  client.includes('result.system !== system.value')
  && client.includes('protectedPromptFragments(user.value)')
  && client.includes('protectedFragments.every((fragment) => result.user.includes(fragment))')
  && client.includes('protected_fragment_count: protectedFragments.length')
), null);
requireCheck('headroom_degrades_to_original_live_prompt', (
  chat.includes('headroom_compression_fallback_original')
  && chat.includes('executionSystem = systemPrompt')
  && chat.includes('executionUser = userPrompt')
), null);
requireCheck('markitdown_binary_types_flag_gated', (
  documents.includes('markitdownAvailable && MARKITDOWN_CONTENT_TYPES.has(contentType)')
  && documents.includes('convertDocumentWithMarkitdown')
), null);
requireCheck('capability_receipt_audited_and_projected', (
  documentStore.includes("'capability_receipt', ${capabilityReceiptJson}::jsonb")
  && documentStore.match(/'capability_receipt', \$\{capabilityReceiptJson\}::jsonb/g)?.length >= 2
), null);

const byId = Object.fromEntries(registry.capabilities.map((entry) => [entry.id, entry]));
requireCheck('all_external_capabilities_default_disabled', (
  ['markitdown', 'hyper_extract', 'headroom'].every((id) => byId[id]?.adopted_by_default === false)
), null);
requireCheck('hyper_extract_authority_forbidden', (
  byId.hyper_extract?.forbidden_scopes?.includes('authoritative_graph_write')
  && byId.hyper_extract?.forbidden_scopes?.includes('direct_hyper_extract_mcp_server_customer_exposure')
  && !worker.toLowerCase().includes('hyper_extract')
  && !runner.toLowerCase().includes('hyper_extract')
), null);
requireCheck('canonical_policy_matches_runtime', (
  policy.includes('Runtime Adapter Authority')
  && policy.includes('disabled by default')
  && policy.includes('GraphSuggestion')
), null);

const report = {
  schema_id: 'xlooop.external_capability_runtime_adapter_verifier.v1',
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  check_count: checks.length,
  failure_count: failures.length,
  failures,
  checks,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
