#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
const matrix = readJson('data/operations-live-stream-source-coverage.json');
const stream = readJson(matrix.source || 'data/operations-live-stream.json');
const failures = [];

function check(id, ok, details = {}) {
  if (!ok) failures.push({ id, ...details });
}

const rows = Array.isArray(stream.rows) ? stream.rows : [];
const streamTypes = new Set(rows.map(row => row.stream_type));
const sourceAdapters = new Set(rows.map(row => row.source_adapter));
const missingStreamTypes = (matrix.required_stream_types || []).filter(item => !streamTypes.has(item));
const missingSourceAdapters = (matrix.required_source_adapters || []).filter(item => !sourceAdapters.has(item));
const requiredCount = (matrix.required_stream_types || []).length + (matrix.required_source_adapters || []).length;
const missingCount = missingStreamTypes.length + missingSourceAdapters.length;
const coveragePercent = Number((((requiredCount - missingCount) / requiredCount) * 100).toFixed(2));

check('coverage_schema', matrix.schema === 'xlooop.operations_live_stream_source_coverage.v1');
check('authority_binding', matrix.authority === 'MB-P operations_live_stream_v1');
check('stream_schema_id', stream.schema_id === 'operations_live_stream_v1');
check('stream_authority_model', stream.authority_model === 'mbp_owned_read_model_snapshot');
check('claim_boundary', matrix.claim_boundary === 'internal_sla_polling_not_public_live_streaming_operations');
check('no_missing_stream_types', missingStreamTypes.length === 0, { missingStreamTypes });
check('no_missing_source_adapters', missingSourceAdapters.length === 0, { missingSourceAdapters });
check('coverage_target_met', coveragePercent >= Number(matrix.readiness_target_percent || 100), { coveragePercent, target: matrix.readiness_target_percent });
check('stream_reports_coverage', stream.required_source_coverage?.coverage_percent === coveragePercent, {
  streamCoverage: stream.required_source_coverage?.coverage_percent,
  coveragePercent,
});
check('metrics_reports_coverage', stream.metrics?.source_coverage_percent === coveragePercent, {
  metricCoverage: stream.metrics?.source_coverage_percent,
  coveragePercent,
});

const report = {
  schema: 'xlooop.operations_live_stream_source_coverage.result.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  rows: rows.length,
  stream_types: [...streamTypes].sort(),
  source_adapters: [...sourceAdapters].sort(),
  coverage_percent: coveragePercent,
  failures,
};

console.log(JSON.stringify(report, null, 2));
if (!failures.length) {
  console.log('verify-operations-live-stream-source-coverage · PASS · 100% source coverage visible to dashboard/readiness');
}
process.exit(failures.length ? 1 : 0);
