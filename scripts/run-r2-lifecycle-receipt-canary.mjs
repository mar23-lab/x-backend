#!/usr/bin/env node
// Produce a real Cloudflare R2 delete/export/retention receipt using internal,
// non-customer validation data. The script fails closed when R2 is unavailable
// and writes the local receipt only after every remote proof has succeeded.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

if (process.argv.includes('--self-test')) runSelfTest();
else runLive();

function runLive() {
  const outputPath = path.resolve(requiredArg('output'));
  const bucket = arg('bucket') || 'xlooop-production-lifecycle-receipts';
  const location = arg('location') || 'oc';
  const wrangler = path.join(repoRoot, 'node_modules', '.bin', 'wrangler');
  const runId = `lifecycle-${compactIso(new Date())}-${crypto.randomBytes(4).toString('hex')}`;
  const objectKey = `validation/${runId}/export-payload.json`;
  const receiptPrefix = `receipts/${runId}/`;
  const manifestKey = `${receiptPrefix}export-manifest.json`;
  const proofBundleKey = `${receiptPrefix}proof-bundle.json`;
  const receiptKey = `${receiptPrefix}receipt.json`;
  const holdRuleId = `hold-${runId}`;
  const receiptLockRuleId = `retain-${runId}`;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlooop-r2-lifecycle-'));
  const payloadPath = path.join(workdir, 'export-payload.json');
  const downloadedPath = path.join(workdir, 'downloaded-export-payload.json');
  const missingPath = path.join(workdir, 'must-not-exist.json');
  const manifestPath = path.join(workdir, 'export-manifest.json');
  const proofBundlePath = path.join(workdir, 'proof-bundle.json');
  const receiptPath = path.join(workdir, 'receipt.json');

  assertOutputOutsideRepo(outputPath);
  if (!fs.existsSync(wrangler)) fail('wrangler_missing', { expected_path: wrangler });

  const list = command(wrangler, ['r2', 'bucket', 'list'], { allowFailure: true });
  if (list.status !== 0) {
    const combined = `${list.stdout}\n${list.stderr}`;
    const reason = /code:\s*10042|enable R2/i.test(combined) ? 'r2_not_enabled' : 'r2_bucket_list_failed';
    fail(reason, { status: list.status, output: tail(combined) });
  }

  const bucketExists = new RegExp(`(^|\\s)${escapeRegExp(bucket)}($|\\s)`, 'm').test(`${list.stdout}\n${list.stderr}`);
  const bucketCreate = bucketExists
    ? proof('bucket_exists', `${list.stdout}\n${list.stderr}`)
    : command(wrangler, ['r2', 'bucket', 'create', bucket, '--location', location]);

  const now = new Date();
  const payload = {
    schema_id: 'xlooop.lifecycle_validation_payload.v1',
    run_id: runId,
    data_class: 'internal_non_customer_validation',
    tenant_scope: arg('tenant-scope') || 'tenant_internal_validation',
    company_id: arg('company-id') || 'company_internal_validation',
    user_id: arg('user-id') || 'user_internal_validation',
    workspace_scope: arg('workspace-scope') || 'workspace_internal_validation',
    generated_at: now.toISOString(),
    content: 'R2 lifecycle validation payload. Contains no customer data.',
  };
  writeJson(payloadPath, payload);
  const objectHash = sha256File(payloadPath);

  const objectPut = command(wrangler, ['r2', 'object', 'put', `${bucket}/${objectKey}`, '--remote', '--file', payloadPath, '--content-type', 'application/json', '--force']);
  command(wrangler, ['r2', 'object', 'get', `${bucket}/${objectKey}`, '--remote', '--file', downloadedPath]);
  if (sha256File(downloadedPath) !== objectHash) fail('r2_download_hash_mismatch');

  const holdAdd = command(wrangler, ['r2', 'bucket', 'lock', 'add', bucket, holdRuleId, objectKey, '--retention-days', '1', '--force']);
  const heldDelete = command(wrangler, ['r2', 'object', 'delete', `${bucket}/${objectKey}`, '--remote', '--force'], { allowFailure: true });
  if (heldDelete.status === 0) fail('bucket_lock_did_not_block_delete');

  command(wrangler, ['r2', 'bucket', 'lock', 'remove', bucket, '--name', holdRuleId]);
  const objectDelete = command(wrangler, ['r2', 'object', 'delete', `${bucket}/${objectKey}`, '--remote', '--force']);
  const deletedAt = new Date();
  const negativeRead = command(wrangler, ['r2', 'object', 'get', `${bucket}/${objectKey}`, '--remote', '--file', missingPath], { allowFailure: true });
  if (negativeRead.status === 0 || fs.existsSync(missingPath)) fail('negative_read_after_delete_failed');

  const exportManifest = {
    schema_id: 'xlooop.delete_export_manifest.v1',
    run_id: runId,
    bucket,
    object_key: objectKey,
    object_hash_sha256: objectHash,
    exported_at: now.toISOString(),
    deleted_at: deletedAt.toISOString(),
    raw_customer_data_used: false,
  };
  writeJson(manifestPath, exportManifest);
  const manifestHash = sha256File(manifestPath);
  const manifestPut = command(wrangler, ['r2', 'object', 'put', `${bucket}/${manifestKey}`, '--remote', '--file', manifestPath, '--content-type', 'application/json', '--force']);

  const proofBundle = {
    schema_id: 'xlooop.r2_lifecycle_proof_bundle.v1',
    run_id: runId,
    generated_at: new Date().toISOString(),
    commands: { bucketCreate, objectPut, holdAdd, heldDelete, objectDelete, negativeRead, manifestPut },
  };
  writeJson(proofBundlePath, proofBundle);
  const proofBundleHash = sha256File(proofBundlePath);
  const proofBundlePut = command(wrangler, ['r2', 'object', 'put', `${bucket}/${proofBundleKey}`, '--remote', '--file', proofBundlePath, '--content-type', 'application/json', '--force']);

  const receipt = buildReceipt({
    runId, bucket, objectKey, receiptKey, proofBundleKey, objectHash, manifestHash, proofBundleHash, holdRuleId, deletedAt,
    proofs: { objectPut, manifestPut, proofBundlePut, objectDelete, heldDelete, negativeRead },
  });
  writeJson(receiptPath, receipt);
  const immutableReceiptHash = sha256File(receiptPath);
  const receiptPut = command(wrangler, ['r2', 'object', 'put', `${bucket}/${receiptKey}`, '--remote', '--file', receiptPath, '--content-type', 'application/json', '--force']);
  const receiptLock = command(wrangler, ['r2', 'bucket', 'lock', 'add', bucket, receiptLockRuleId, receiptPrefix, '--retention-indefinite', '--force']);
  const lockList = command(wrangler, ['r2', 'bucket', 'lock', 'list', bucket]);
  if (!`${lockList.stdout}\n${lockList.stderr}`.includes(receiptLockRuleId)) fail('immutable_receipt_lock_not_listed');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(receiptPath, outputPath);
  fs.chmodSync(outputPath, 0o600);

  const verify = command(process.execPath, [path.join(scriptDir, 'verify-public-self-serve-production-receipts.mjs')], {
    env: { ...process.env, XLOOOP_DELETE_EXPORT_RECEIPT_FILE: outputPath },
  });

  console.log(JSON.stringify({
    schema_id: 'xlooop.r2_lifecycle_receipt_canary.v1', status: 'PASS', bucket, run_id: runId,
    receipt_file: outputPath, immutable_receipt_ref: receipt.immutable_receipt_ref,
    immutable_receipt_hash_sha256: immutableReceiptHash,
    immutable_receipt_upload_id: proofId(receiptPut),
    immutable_receipt_lock_id: proofId(receiptLock),
    immutable_receipt_lock_list_id: proofId(lockList),
    verifier: JSON.parse(verify.stdout),
  }, null, 2));
}

function buildReceipt({ runId, bucket, objectKey, receiptKey, proofBundleKey, objectHash, manifestHash, proofBundleHash, holdRuleId, deletedAt, proofs }) {
  return {
    schema_id: 'xlooop.delete_export_object_storage_receipt.v1',
    evidence_class: 'production_live_receipt',
    receipt_id: `receipt.r2.${runId}`,
    immutable_receipt_ref: `xlooop://receipts/cloudflare-r2/${bucket}/${receiptKey}`,
    source_system: 'production_object_storage_lifecycle',
    tenant_scope: arg('tenant-scope') || 'tenant_internal_validation',
    company_id: arg('company-id') || 'company_internal_validation',
    user_id: arg('user-id') || 'user_internal_validation',
    actor_id: arg('actor-id') || 'operator_marat_basyrov',
    workspace_scope: arg('workspace-scope') || 'workspace_internal_validation',
    approval_id: arg('approval-id') || 'approval.current_task.production_lifecycle_validation',
    export_request_id: `export.${runId}`,
    delete_request_id: `delete.${runId}`,
    audit_id: `audit.${runId}`,
    storage_provider: 'cloudflare_r2',
    storage_bucket: bucket,
    object_key: objectKey,
    object_hash_sha256: objectHash,
    export_manifest_hash_sha256: manifestHash,
    proof_bundle_ref: `xlooop://receipts/cloudflare-r2/${bucket}/${proofBundleKey}`,
    proof_bundle_hash_sha256: proofBundleHash,
    receipt_proofs: {
      object_storage_receipt_id: proofId(proofs.objectPut),
      export_manifest_receipt_id: proofId(proofs.manifestPut),
      proof_bundle_receipt_id: proofId(proofs.proofBundlePut),
      delete_request_receipt_id: proofId(proofs.objectDelete),
      legal_hold_receipt_id: proofId(proofs.heldDelete),
      negative_read_receipt_id: proofId(proofs.negativeRead),
    },
    legal_hold_state: 'released_after_verified_delete_denial',
    legal_hold_policy_id: holdRuleId,
    retention_class: 'immutable_receipt_indefinite',
    rollback_boundary: 'deleted payload is irrecoverable; locked receipt and manifest remain authoritative',
    erasure_boundary: 'exact R2 object key; immutable receipt, manifest, and audit lineage excluded',
    tombstone_proof: `r2_negative_read:${proofId(proofs.negativeRead)}`,
    negative_read_after_delete: true,
    raw_customer_data_used: false,
    action_executed_at: deletedAt.toISOString(),
    generated_at: new Date().toISOString(),
    verifier_command: 'npm run verify:public-self-serve-production-receipts',
  };
}

function runSelfTest() {
  const fake = (label, status = 0) => ({ status, stdout: label, stderr: '', proof_id: sha256(label) });
  const receipt = buildReceipt({
    runId: 'lifecycle-20260811t000000z-abcdef12',
    bucket: 'xlooop-production-lifecycle-receipts',
    objectKey: 'validation/lifecycle-20260811t000000z-abcdef12/export-payload.json',
    receiptKey: 'receipts/lifecycle-20260811t000000z-abcdef12/receipt.json',
    proofBundleKey: 'receipts/lifecycle-20260811t000000z-abcdef12/proof-bundle.json',
    objectHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64), proofBundleHash: 'c'.repeat(64),
    holdRuleId: 'hold-lifecycle-20260811t000000z-abcdef12', deletedAt: new Date(),
    proofs: {
      objectPut: fake('object-put'), manifestPut: fake('manifest-put'), proofBundlePut: fake('proof-bundle-put'), objectDelete: fake('object-delete'),
      heldDelete: fake('held-delete-denied', 1), negativeRead: fake('negative-read-not-found', 1),
    },
  });
  const checks = [
    receipt.evidence_class === 'production_live_receipt',
    receipt.source_system === 'production_object_storage_lifecycle',
    receipt.negative_read_after_delete === true,
    receipt.raw_customer_data_used === false,
    Object.values(receipt.receipt_proofs).every(Boolean),
    !JSON.stringify(receipt).match(/placeholder|changeme/i),
  ];
  const selfTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlooop-r2-lifecycle-self-test-'));
  const selfTestReceipt = path.join(selfTestDir, 'receipt.json');
  writeJson(selfTestReceipt, receipt);
  const verifier = command(process.execPath, [path.join(scriptDir, 'verify-public-self-serve-production-receipts.mjs')], {
    env: { ...process.env, XLOOOP_DELETE_EXPORT_RECEIPT_FILE: selfTestReceipt },
    allowFailure: true,
  });
  checks.push(verifier.status === 0 && JSON.parse(verifier.stdout).status === 'PASS');
  if (checks.some((value) => !value)) fail('self_test_failed', { checks });
  console.log(JSON.stringify({ schema_id: 'xlooop.r2_lifecycle_receipt_canary.self_test.v1', status: 'PASS', checks: checks.length }, null, 2));
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 * 4, timeout: 120_000,
    env: options.env || process.env,
  });
  const record = {
    status: result.status ?? 1,
    signal: result.signal || null,
    stdout: sanitizeOutput(result.stdout || ''),
    stderr: sanitizeOutput(result.stderr || result.error?.message || ''),
  };
  record.proof_id = sha256(JSON.stringify(record));
  if (!options.allowFailure && record.status !== 0) fail('command_failed', {
    command: [path.basename(bin), ...args], status: record.status, output: tail(`${record.stdout}\n${record.stderr}`),
  });
  return record;
}

function proof(label, output) {
  const record = { status: 0, stdout: output, stderr: '', label };
  record.proof_id = sha256(JSON.stringify(record));
  return record;
}

function proofId(record) { return `sha256:${record?.proof_id || sha256(JSON.stringify(record || {}))}`; }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function sha256File(file) { return sha256(fs.readFileSync(file)); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function arg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : '';
}

function requiredArg(name) { const value = arg(name); if (!value) fail('required_argument_missing', { argument: `--${name}` }); return value; }
function assertOutputOutsideRepo(outputPath) { const relative = path.relative(repoRoot, outputPath); if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) fail('output_must_be_outside_repo', { output_path: outputPath }); }
function compactIso(date) { return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z').toLowerCase(); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function tail(value, length = 2000) { return String(value || '').slice(-length); }
function sanitizeOutput(value) {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replaceAll(os.homedir(), '$HOME')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[removed]')
    .replace(/(api[_-]?token["'=:\s]+)[^\s"']+/gi, '$1[removed]')
    .replace(/(secret(?:AccessKey)?["'=:\s]+)[^\s"']+/gi, '$1[removed]');
}
function fail(id, details = {}) { console.error(JSON.stringify({ schema_id: 'xlooop.r2_lifecycle_receipt_canary.v1', status: 'FAIL', failure: { id, ...details } }, null, 2)); process.exit(1); }
