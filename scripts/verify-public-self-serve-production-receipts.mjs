#!/usr/bin/env node
// Fail-closed public self-serve receipt gate.
//
// Internal canary receipts may prove contract shape, but public/self-serve
// enablement requires a real production_live_receipt from the retention/object
// storage/legal-hold lane.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const receiptFile = process.env.XLOOOP_DELETE_EXPORT_RECEIPT_FILE || '';
const checks = [];
const failures = [];
const productionEvidenceFreshnessDays = 7;

function check(id, condition, details = {}) {
  const status = condition ? 'PASS' : 'FAIL';
  checks.push({ id, status, ...details });
  if (!condition) failures.push({ id, ...details });
}

function fail(id, details = {}) {
  check(id, false, details);
}

const requiredProductionFields = [
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
  'receipt_proofs',
  'legal_hold_policy_id',
  'retention_class',
  'rollback_boundary',
  'action_executed_at',
  'generated_at',
  'verifier_command',
];

if (!receiptFile) {
  fail('production_receipt_env_required', {
    env: 'XLOOOP_DELETE_EXPORT_RECEIPT_FILE',
    message: 'Public self-serve enablement requires an explicit production receipt file.',
  });
} else {
  const resolved = path.resolve(receiptFile);
  check('production_receipt_file_exists', fs.existsSync(resolved), { receipt_file: resolved });
  if (fs.existsSync(resolved)) {
    let receipt = null;
    try {
      receipt = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      check('production_receipt_json_valid', true, { receipt_file: resolved });
    } catch (error) {
      fail('production_receipt_json_invalid', { receipt_file: resolved, error: error.message });
    }

    if (receipt) {
      check('receipt_schema_valid', receipt.schema_id === 'xlooop.delete_export_object_storage_receipt.v1', {
        schema_id: receipt.schema_id,
      });
      check('receipt_is_production_live', receipt.evidence_class === 'production_live_receipt', {
        evidence_class: receipt.evidence_class,
      });
      const missing = requiredProductionFields.filter((field) => receipt[field] === undefined || receipt[field] === '');
      check('production_receipt_required_fields_present', missing.length === 0, { missing });
      check('receipt_id_immutable_shape', /^receipt\.[a-z0-9_.:-]+$/.test(String(receipt.receipt_id || '')), {
        receipt_id: receipt.receipt_id || '',
      });
      check('immutable_receipt_ref_shape', /^xlooop:\/\/receipts\//.test(String(receipt.immutable_receipt_ref || '')), {
        immutable_receipt_ref: receipt.immutable_receipt_ref || '',
      });
      check('source_system_is_production_lifecycle', receipt.source_system === 'production_object_storage_lifecycle', {
        source_system: receipt.source_system || '',
      });
      const serialized = JSON.stringify(receipt).toLowerCase();
      check('production_receipt_no_placeholder_markers', !/(synthetic|placeholder|example|redacted|changeme)/.test(serialized), {
        forbidden_markers: ['synthetic', 'placeholder', 'example', 'redacted', 'changeme'],
      });
      const actionTime = Date.parse(receipt.action_executed_at || '');
      const generatedTime = Date.parse(receipt.generated_at || '');
      check('production_receipt_dates_parse', !Number.isNaN(actionTime) && !Number.isNaN(generatedTime), {
        action_executed_at: receipt.action_executed_at || '',
        generated_at: receipt.generated_at || '',
      });
      check('production_receipt_action_not_after_generated', Number.isNaN(actionTime) || Number.isNaN(generatedTime) || actionTime <= generatedTime, {
        action_executed_at: receipt.action_executed_at || '',
        generated_at: receipt.generated_at || '',
      });
      const generatedAgeDays = Number.isNaN(generatedTime)
        ? null
        : Math.round(((Date.now() - generatedTime) / 864e5) * 100) / 100;
      check('production_receipt_fresh_enough', generatedAgeDays !== null && generatedAgeDays >= 0 && generatedAgeDays <= productionEvidenceFreshnessDays, {
        generated_age_days: generatedAgeDays,
        max_age_days: productionEvidenceFreshnessDays,
      });
      check('verifier_command_uses_public_receipt_gate', /verify:public-self-serve-production-receipts/.test(String(receipt.verifier_command || '')), {
        verifier_command: receipt.verifier_command || '',
      });
      const receiptProofProblems = receiptProofProblemsFor(receipt.receipt_proofs);
      check('external_receipt_proofs_present', receiptProofProblems.length === 0, {
        receipt_proof_problems: receiptProofProblems,
        requirement: 'Production authority requires external object-storage/legal-hold/export/delete/negative-read receipt ids.',
      });
      check('negative_read_after_delete_true', receipt.negative_read_after_delete === true, {
        negative_read_after_delete: receipt.negative_read_after_delete,
      });
      check('raw_customer_data_not_embedded', receipt.raw_customer_data_used === false, {
        raw_customer_data_used: receipt.raw_customer_data_used,
      });
      check('object_hash_sha256_valid', /^[a-f0-9]{64}$/.test(String(receipt.object_hash_sha256 || '')), {
        object_hash_sha256: receipt.object_hash_sha256 || '',
      });
      check('export_manifest_hash_sha256_valid', /^[a-f0-9]{64}$/.test(String(receipt.export_manifest_hash_sha256 || '')), {
        export_manifest_hash_sha256: receipt.export_manifest_hash_sha256 || '',
      });
      check('legal_hold_state_present', Boolean(receipt.legal_hold_state), {
        legal_hold_state: receipt.legal_hold_state || '',
      });
      check('erasure_boundary_present', Boolean(receipt.erasure_boundary), {
        erasure_boundary: receipt.erasure_boundary || '',
      });
      check('tombstone_proof_present', Boolean(receipt.tombstone_proof), {
        tombstone_proof: receipt.tombstone_proof || '',
      });
    }
  }
}

const report = {
  schema_id: 'xlooop.public_self_serve_production_receipts.verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  public_self_serve_authority: failures.length === 0,
  checks,
  failures,
};

console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);

function receiptProofProblemsFor(receiptProofs = {}) {
  const problems = [];
  for (const field of [
    'object_storage_receipt_id',
    'export_manifest_receipt_id',
    'delete_request_receipt_id',
    'legal_hold_receipt_id',
    'negative_read_receipt_id',
  ]) {
    if (typeof receiptProofs[field] !== 'string' || receiptProofs[field].trim() === '') {
      problems.push(`receipt_proofs.${field}`);
    }
  }
  return problems;
}
