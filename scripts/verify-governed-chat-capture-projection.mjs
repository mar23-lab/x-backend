#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

const requiredAllowed = [
  'capture_id',
  'intent_id',
  'summary',
  'contract_proposal.status',
  'owner_approval.status',
  'repo_evidence_refs',
  'verification.required_gates',
];
const requiredForbidden = [
  'raw_transcript',
  'raw_text',
  'raw_content',
  'private_payload',
  'secret',
  'token',
  'credential',
  'mbp_private_note_body',
  'protected_source_code',
];

const failures = [];
function check(id, ok, details = {}) {
  if (!ok) failures.push({ id, ...details });
}
function includesAll(values, required) {
  return Array.isArray(values) && required.every((item) => values.includes(item));
}

const projection = readJson('data/governed-chat-capture-projection.example.json');
const contract = read('src/contracts/persistence-collaboration/governed-chat-capture.contract.ts');
const test = read('src/__contracts__/governedChatCaptureProjection.contract.test.ts');
const barrel = read('src/contracts/persistence-collaboration/index.ts');
const serialized = JSON.stringify(projection).toLowerCase();

check('schema_version', projection.schema_version === 'xlooop.governed_chat_capture_projection.v1');
check('contract_kind', projection.contract_kind === 'governed_chat_capture_projection');
check('source_packet_schema', projection.source_packet_schema_id === 'xcp_governed_chat_capture_packet_v1');
check('source_repo_mbp', projection.source_repo === 'MB-P');
check('target_repo_demo', projection.target_repo === 'Xlooop-XCP-demo');
check('owner_approval_required', projection.mbp_record_requires_owner_approval === true);
check('no_mbp_writeback', projection.mbp_writeback_allowed === false);
check('no_raw_transcript', projection.raw_transcript_included === false);
check('no_private_payload', projection.private_payload_included === false);
check('allowed_fields_cover_required', includesAll(projection.allowed_fields, requiredAllowed));
check('forbidden_fields_cover_required', includesAll(projection.forbidden_fields, requiredForbidden));
check('source_refs_no_raw_content', (projection.source_refs || []).every((ref) => ref.raw_content_included === false));
check('xfront_xdocs_readonly', (projection.repo_evidence_refs || []).every((ref) =>
  (ref.repo !== 'x-front' && ref.repo !== 'x-docs') || ref.access_mode === 'read_only_evidence'
));
check('no_bitbucket_refs', !serialized.includes('bitbucket'));
check('contract_validator_present', contract.includes('isGovernedChatCaptureProjectionContract'));
check('contract_forbids_writeback', contract.includes('mbp_writeback_allowed: false'));
check('contract_forbids_raw_transcript', contract.includes('raw_transcript_included: false'));
check('barrel_exports_contract', barrel.includes("export * from './governed-chat-capture.contract'"));
check('type_test_blocks_writeback', test.includes('@ts-expect-error Xlooop projection cannot write back to MB-P'));
check('type_test_blocks_raw_transcript', test.includes('@ts-expect-error raw chat transcripts are not allowed'));

const summary = {
  status: failures.length ? 'FAIL' : 'PASS',
  capture_id: projection.capture_id,
  projection_mode: projection.projection_mode,
  allowed_fields: projection.allowed_fields?.length || 0,
  forbidden_fields: projection.forbidden_fields?.length || 0,
  failures,
};

console.log(JSON.stringify(summary, null, 2));
if (!failures.length) {
  console.log('verify-governed-chat-capture-projection · PASS · metadata-only projection contract protected');
}
process.exit(failures.length ? 1 : 0);
