#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoReadOnlyVerificationLock } from './lib/generated-artifact-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const mbpRoot = process.env.MBP_ROOT || '/Users/maratbasyrov/WIP/MB-P';
const toolRoot = process.env.MBP_EXPORT_TOOL_ROOT || mbpRoot;
const python = process.env.PYTHON || '/usr/bin/python3';
const exportScript = path.join(toolRoot, '_sys/scripts/export_operations_live_stream.py');
const receiptExportScript = path.join(toolRoot, '_sys/scripts/export_gateway_receipts.py');
const exportedSnapshot = path.join(mbpRoot, '_sys/xcp-system/cross_repo_drafts/Xlooop-XCP-demo/data/operations-live-stream.json');
const exportedReceipts = path.join(mbpRoot, '_sys/xcp-system/cross_repo_drafts/Xlooop-XCP-demo/data/mbp-gateway-receipts.json');
const outPath = path.join(repoRoot, 'data/operations-live-stream.json');
const receiptOutPath = path.join(repoRoot, 'data/mbp-gateway-receipts.json');
const consumerBindingScript = path.join(repoRoot, 'scripts/generate-operations-live-stream.mjs');

if (process.env.XCP_VERIFY_READONLY === '1') {
  console.error(JSON.stringify({
    schema_version: 'xlooop.operations_live_stream_poll.v1',
    status: 'FAIL',
    reason: 'XCP_VERIFY_READONLY forbids polling/refreshed tracked OperationsLiveStream artifacts',
    renewal_command: 'npm run commercial:preflight',
  }, null, 2));
  process.exit(1);
}

assertNoReadOnlyVerificationLock('poll-mbp-operations-live-stream');

function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function isAuthoritySnapshot(payload) {
  return payload?.schema_id === 'operations_live_stream_v1'
    && payload?.contract_version === 'v1.0.0'
    && payload?.authority_model === 'mbp_owned_read_model_snapshot'
    && payload?.source_repo === 'MB-P'
    && payload?.consumer_repo === 'Xlooop-XCP-demo'
    && payload?.source_mode === 'staged_snapshot'
    && payload?.fallback_fixture_used === false
    && payload?.direct_mbp_repo_write_allowed === false
    && payload?.claim_posture?.live_streaming_operations === 'internal_sla_poll_allowed_public_blocked'
    && payload?.gateway_poll_sla?.state === 'green'
    && payload?.authoritative_receipt_ingestion?.source_adapter === 'mbp-gateway-receipt-export'
    && payload?.authoritative_receipt_ingestion?.coverage_percent === 100
    && payload?.required_source_coverage?.coverage_percent === 100
    && Array.isArray(payload?.rows)
    && payload.rows.length > 0;
}

function isAuthorityReceiptProjection(payload) {
  return payload?.schema_id === 'mbp_gateway_receipts_v1'
    && payload?.schema_version === 'mbp.gateway_receipts.v1'
    && payload?.contract_version === 'v1.0.0'
    && payload?.authority_source === 'mb-p-gateway'
    && payload?.projection_mode === 'read_only_authoritative_receipt_projection'
    && payload?.source_mode === 'mbp_gateway_export_poll'
    && payload?.direct_mbp_repo_write_allowed === false
    && payload?.raw_content_included === false
    && payload?.poll_sla?.state === 'green'
    && payload?.receipt_coverage?.coverage_percent === 100
    && Array.isArray(payload?.receipts)
    && payload.receipts.length > 0;
}

function copySnapshot(fromPath, toPath, validator, label, countKey) {
  const payload = readJson(fromPath);
  if (!validator(payload)) {
    throw new Error(`MB-P ${label} failed authority checks: ${fromPath}`);
  }
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  if (path.resolve(fromPath) !== path.resolve(toPath)) {
    fs.copyFileSync(fromPath, toPath);
  }
  const count = Array.isArray(payload[countKey]) ? payload[countKey].length : 0;
  const coverage = payload.required_source_coverage?.coverage_percent ?? payload.receipt_coverage?.coverage_percent;
  console.log(`poll-mbp-operations-live-stream · copied ${path.relative(repoRoot, toPath)} · ${count} ${countKey} · coverage ${coverage}%`);
}

function applyConsumerReadModelBindings() {
  if (!fs.existsSync(consumerBindingScript)) return;
  const result = spawnSync(process.execPath, [consumerBindingScript], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  const payload = readJson(outPath);
  if (!isAuthoritySnapshot(payload)) {
    throw new Error('Consumer-bound OperationsLiveStream failed authority checks after poll');
  }
  const xbizRows = payload.rows.filter((row) => row.workspace_id === 'x-biz' && row.project_id === 'x-biz-investor-readiness').length;
  console.log(`poll-mbp-operations-live-stream · consumer bindings applied · rows ${payload.rows.length} · x-biz investor readiness rows ${xbizRows}`);
}

if (fs.existsSync(receiptExportScript)) {
  const receiptResult = spawnSync(python, [
    receiptExportScript,
    '--source-root',
    mbpRoot,
    '--output',
    receiptOutPath,
  ], {
    stdio: 'inherit',
    env: process.env,
  });
  if (receiptResult.error) throw receiptResult.error;
  if ((receiptResult.status ?? 1) !== 0) process.exit(receiptResult.status ?? 1);
  copySnapshot(receiptOutPath, receiptOutPath, isAuthorityReceiptProjection, 'gateway receipt projection', 'receipts');
} else if (fs.existsSync(exportedReceipts)) {
  copySnapshot(exportedReceipts, receiptOutPath, isAuthorityReceiptProjection, 'gateway receipt projection', 'receipts');
} else {
  throw new Error(`No MB-P gateway receipt export found. Expected ${receiptExportScript} or ${exportedReceipts}`);
}

if (process.env.XLOOOP_USE_MBP_OPERATIONS_EXPORT === '1') {
  if (fs.existsSync(exportScript)) {
    const result = spawnSync(python, [
      exportScript,
      '--source-root',
      mbpRoot,
      '--output',
      outPath,
    ], {
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
    copySnapshot(outPath, outPath, isAuthoritySnapshot, 'OperationsLiveStream snapshot', 'rows');
  } else if (fs.existsSync(exportedSnapshot)) {
    copySnapshot(exportedSnapshot, outPath, isAuthoritySnapshot, 'OperationsLiveStream snapshot', 'rows');
  } else {
    throw new Error(`No MB-P OperationsLiveStream export found. Expected ${exportScript} or ${exportedSnapshot}`);
  }
} else {
  applyConsumerReadModelBindings();
}

if (process.env.XLOOOP_USE_MBP_OPERATIONS_EXPORT === '1') {
  applyConsumerReadModelBindings();
}
