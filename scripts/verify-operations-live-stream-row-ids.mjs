#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const streamPath = path.join(repoRoot, 'data', 'operations-live-stream.json');
const stream = JSON.parse(fs.readFileSync(streamPath, 'utf8'));
const rows = Array.isArray(stream.rows) ? stream.rows : [];

const missing = [];
const seen = new Map();
const duplicates = [];

rows.forEach((row, index) => {
  const rowId = typeof row?.row_id === 'string' ? row.row_id.trim() : '';
  if (!rowId) {
    missing.push({ index, title: row?.title || null, stream_type: row?.stream_type || null });
    return;
  }
  if (seen.has(rowId)) {
    duplicates.push({
      row_id: rowId,
      first_index: seen.get(rowId),
      duplicate_index: index,
      stream_type: row?.stream_type || null,
      title: row?.title || null,
    });
    return;
  }
  seen.set(rowId, index);
});

const summary = {
  status: missing.length || duplicates.length ? 'FAIL' : 'PASS',
  rows: rows.length,
  unique_row_ids: seen.size,
  missing: missing.slice(0, 10),
  duplicates: duplicates.slice(0, 10),
};

console.log(JSON.stringify(summary, null, 2));
if (summary.status === 'PASS') {
  console.log('verify-operations-live-stream-row-ids · PASS · row_id uniqueness protected');
}
process.exit(summary.status === 'PASS' ? 0 : 1);
