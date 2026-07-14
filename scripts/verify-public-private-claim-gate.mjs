#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanActiveSurfaceTruthfulness } from './current-surface-truthfulness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const projection = readJson('data/mbp-operations-projection.json');
const manifest = readJson('data/mbp-projection-export-manifest.json');
const posture = readJson('data/public-private-claim-posture.json');
const operationsLiveStream = readJson('data/operations-live-stream.json');
const gatewayReceipts = readJson('data/mbp-gateway-receipts.json');
const truthfulness = scanActiveSurfaceTruthfulness(repoRoot);

const findings = [];

expect(posture.schema === 'xlooop.public_private_claim_posture.v1', 'posture_schema_v1', 'public/private claim posture schema must be v1');
expect(posture.projection_id === projection.projection_id, 'projection_binding', 'claim posture projection_id must match active MB-P projection');
expect(posture.manifest_export_id === manifest.export_id, 'manifest_binding', 'claim posture manifest_export_id must match active export manifest');
expect(posture.operation_mode === projection.operation_mode, 'operation_mode_binding', 'claim posture operation_mode must match active MB-P projection');
expect(posture.private_raw_content_included === projection.private_raw_content_included, 'private_projection_binding', 'claim posture private_raw_content_included must match active MB-P projection');
expect(posture.private_raw_content_included === manifest.private_raw_content_included, 'private_manifest_binding', 'claim posture private_raw_content_included must match active export manifest');
expect(posture.writes_back_to_mbp_allowed === projection.writes_back_to_mbp_allowed, 'writeback_projection_binding', 'claim posture writeback flag must match active MB-P projection');
expect(manifest.writes_back_to_source_allowed === false, 'manifest_no_writeback', 'export manifest must keep writes_back_to_source_allowed=false');
expect(truthfulness.status === 'PASS', 'current_surface_truthfulness', 'active surface truthfulness scan must pass');
expect(posture.stream_claim_posture?.read_model_snapshot === 'allowed_internal_owner_proof', 'stream_read_model_snapshot_allowed', 'stream claim posture must allow read-model snapshot for internal owner proof');
expect(posture.stream_claim_posture?.live_streaming_operations === 'internal_sla_poll_allowed_public_blocked', 'stream_live_operations_internal_only', 'stream claim posture must allow only internal SLA-protected polling while public claims stay blocked');
expect(posture.stream_claim_posture?.public_claim_allowed === false, 'stream_public_claim_blocked', 'stream public claim must remain blocked');
expect(operationsLiveStream.gateway_poll_sla?.state === 'green', 'gateway_poll_sla_green', 'OperationsLiveStream must expose a green internal receipt poll SLA');
expect(operationsLiveStream.authoritative_receipt_ingestion?.coverage_percent === 100, 'authoritative_receipt_coverage', 'OperationsLiveStream must bind to 100% authoritative receipt coverage');
expect(gatewayReceipts.schema_id === 'mbp_gateway_receipts_v1', 'gateway_receipt_schema', 'gateway receipt projection must be MB-P-owned v1');
expect(gatewayReceipts.poll_sla?.state === 'green', 'gateway_receipt_sla_green', 'gateway receipt projection must expose a green poll SLA');
expect(gatewayReceipts.receipt_coverage?.coverage_percent === 100, 'gateway_receipt_coverage', 'gateway receipt coverage must be 100%');
expect(gatewayReceipts.direct_mbp_repo_write_allowed === false, 'gateway_receipt_no_writeback', 'gateway receipt projection must block direct MB-P writes');
expect(gatewayReceipts.raw_content_included === false, 'gateway_receipt_no_raw_content', 'gateway receipt projection must not include raw MB-P content');
expect(operationsLiveStream.claim_posture?.read_model_snapshot === posture.stream_claim_posture?.read_model_snapshot, 'stream_posture_read_model_binding', 'OperationsLiveStream read-model claim posture must match claim gate');
expect(operationsLiveStream.claim_posture?.live_streaming_operations === posture.stream_claim_posture?.live_streaming_operations, 'stream_posture_live_binding', 'OperationsLiveStream live-streaming claim posture must match claim gate');
expect(operationsLiveStream.claim_posture?.public_claim_allowed === posture.stream_claim_posture?.public_claim_allowed, 'stream_posture_public_binding', 'OperationsLiveStream public claim posture must match claim gate');

const privateDataPresent = projection.private_raw_content_included === true || manifest.private_raw_content_included === true;
const internalFullMode = projection.operation_mode === 'internal_full_owner_operations'
  || manifest.operation_mode === 'internal_full_owner_operations';
const internalFullRedaction = projection.redaction_state === 'internal_full'
  || manifest.redaction_state === 'internal_full';

if (privateDataPresent || internalFullMode || internalFullRedaction) {
  expect(hasTierStatus('internal_owner_proof', 'allowed'), 'internal_owner_proof_allowed', 'internal owner proof must be explicitly allowed');
  expect(hasTierStatus('controlled_commercial_walkthrough', 'allowed_with_restrictions'), 'controlled_walkthrough_restricted', 'controlled commercial walkthrough must be restricted');
  expect(hasTierStatus('pilot_discovery', 'allowed_with_restrictions'), 'pilot_discovery_restricted', 'pilot discovery must be restricted');
  expect(hasTierStatus('public_unrestricted', 'blocked'), 'public_unrestricted_blocked', 'unrestricted public claims must be blocked while private/internal data is present');
  expect(hasTierStatus('signed_pilot_terms', 'blocked'), 'signed_pilot_terms_blocked', 'signed pilot terms must be blocked without owner claim sign-off packet');
  expect(hasTierStatus('production_saas_now', 'blocked'), 'production_saas_now_blocked', 'production SaaS claims must be blocked without public-safe production posture');
  expect(mustNotSayIncludes('production SaaS fully operating live MB-P'), 'production_claim_phrase_blocked', 'claim boundary must block production-live wording');
  expect(mustNotSayIncludes('unrestricted public demo'), 'public_demo_phrase_blocked', 'claim boundary must block unrestricted public demo wording');
}

for (const action of posture.required_blocked_actions || []) {
  expect(includes(projection.blocked_actions, action), `projection_blocks_${action}`, `projection must block ${action}`);
  expect(includes(manifest.blocked_actions, action), `manifest_blocks_${action}`, `manifest must block ${action}`);
}

for (const gate of posture.required_gates || []) {
  expect(packageScriptExists(gate), `package_script_${gate}`, `package.json must expose ${gate}`);
}

expect(includes(posture.owner_decision_needed_for_green_public_claims, 'redacted_public_projection_or_demo_dataset'), 'public_redaction_decision_needed', 'green public claims must require redacted public projection or dataset');
expect(includes(posture.owner_decision_needed_for_green_public_claims, 'public_claim_signoff_packet'), 'public_claim_signoff_needed', 'green public claims must require owner public claim sign-off');
expect(includes(posture.owner_decision_needed_for_green_public_claims, 'production_receipt_export_sla'), 'production_sla_needed', 'production claims must require receipt export SLA');

const summary = {
  schema: 'xlooop.public_private_claim_gate.result.v1',
  status: findings.length ? 'FAIL' : 'PASS',
  projection_id: projection.projection_id,
  export_id: manifest.export_id,
  operation_mode: projection.operation_mode,
  private_raw_content_included: privateDataPresent,
  redaction_state: projection.redaction_state,
  writes_back_to_mbp_allowed: projection.writes_back_to_mbp_allowed,
  allowed_tiers: (posture.tiers || []).filter((tier) => tier.status === 'allowed' || tier.status === 'allowed_with_restrictions').map((tier) => tier.tier),
  blocked_tiers: (posture.tiers || []).filter((tier) => tier.status === 'blocked').map((tier) => tier.tier),
  current_surface_truthfulness: truthfulness.status,
  findings,
};

console.log(JSON.stringify(summary, null, 2));
process.exit(findings.length ? 1 : 0);

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function expect(condition, id, message) {
  if (condition) return;
  findings.push({ id, message });
}

function hasTierStatus(tier, status) {
  return (posture.tiers || []).some((candidate) => candidate.tier === tier && candidate.status === status);
}

function mustNotSayIncludes(text) {
  return includes(posture.claim_boundary?.must_not_say, text);
}

function includes(values, expected) {
  return Array.isArray(values) && values.includes(expected);
}

function packageScriptExists(scriptName) {
  const packageJson = readJson('package.json');
  return Boolean(packageJson.scripts?.[scriptName]);
}
