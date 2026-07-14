#!/usr/bin/env node
// scripts/push-mbp-projection-to-workers.mjs · 260710-F M4 (H1) — push the MB-P operations
// PROJECTION (+ its export manifest, atomically) to the Worker's projection live rail.
//
// SIBLING of push-operations-live-stream-to-workers.mjs, deliberately NOT a --stream flag on it:
// that script is pinned by verify-live-stream-ingest.mjs greps and its receipt file's schema is
// consumed by verify-cron-freshness.mjs — interleaving a second contract through it risks both.
// Same pattern as the route side (separate /mbp-projection/ingest endpoint).
//
// WHY the pair is atomic: the operator-visible freshness is min(projection.valid_until,
// manifest.valid_until) — pushing only the projection leaves the cockpit reading the stale manifest.
//
// Usage:
//   node scripts/push-mbp-projection-to-workers.mjs [--dry-run] \
//     [--projection=data/mbp-operations-projection.json] \
//     [--manifest=data/mbp-projection-export-manifest.json] [--api=...] [--receipt=...]
//
// Auth: MBP_LIVE_STREAM_INGEST_TOKEN env (same producer trust domain as the live-stream push).
// Receipt: ~/.mbp/xlooop-projection-push-receipt.json — its OWN file, never the live-stream
// receipt (verify-cron-freshness.mjs consumes that one; clobbering it corrupts cron verification).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoReadOnlyVerificationLock } from './lib/generated-artifact-lock.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagVal = (name) => {
  const hit = argv.find((a) => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
};

const DRY_RUN = hasFlag('--dry-run');
const PROJECTION_FILE = flagVal('--projection') || path.join(REPO, 'data/mbp-operations-projection.json');
const MANIFEST_FILE = flagVal('--manifest') || path.join(REPO, 'data/mbp-projection-export-manifest.json');
const API_BASE = (flagVal('--api') || process.env.XLOOOP_API_BASE_URL || 'https://api.xlooop.com').replace(/\/$/, '');
const INGEST_URL = API_BASE + '/api/v1/mbp-projection/ingest';
const TOKEN = (process.env.MBP_LIVE_STREAM_INGEST_TOKEN || '').trim();
const RECEIPT_PATH = flagVal('--receipt') || path.join(os.homedir(), '.mbp', 'xlooop-projection-push-receipt.json');

assertNoReadOnlyVerificationLock('push-mbp-projection-to-workers');

function fail(msg) {
  console.error('✗ push-mbp-projection · ' + msg);
  process.exit(1);
}

let projection, manifest;
try { projection = JSON.parse(readFileSync(PROJECTION_FILE, 'utf8')); } catch (e) { fail('cannot read projection at ' + PROJECTION_FILE + ' · ' + e.message); }
try { manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')); } catch (e) { fail('cannot read manifest at ' + MANIFEST_FILE + ' · ' + e.message); }

if (!projection || !Array.isArray(projection.packets)) fail('projection has no packets[] — not an mbp-operations-projection document');
if (typeof projection.generated_at !== 'string' || typeof projection.valid_until !== 'string') fail('projection missing generated_at/valid_until');
if (!manifest || typeof manifest.valid_until !== 'string') fail('manifest missing valid_until — the pair must push atomically (freshness = min of the two)');

const envelope = {
  _meta: { schema: 'xlooop.mbp_projection_live_rail.v1' },
  generated_at: projection.generated_at,
  valid_until: projection.valid_until,
  operations_projection: projection,
  projection_export_manifest: manifest,
};
const payload = JSON.stringify(envelope);
const sha256 = createHash('sha256').update(payload).digest('hex');

console.log('push-mbp-projection-to-workers');
console.log('  projection  ' + PROJECTION_FILE);
console.log('  manifest    ' + MANIFEST_FILE);
console.log('  target      ' + INGEST_URL);
console.log('  packets     ' + projection.packets.length);
console.log('  generated   ' + projection.generated_at);
console.log('  valid_until ' + projection.valid_until + ' (projection) / ' + manifest.valid_until + ' (manifest)');
console.log('  sha256      ' + sha256.slice(0, 16) + '…');

if (DRY_RUN) {
  console.log('\n--dry-run · NOT posting. Set MBP_LIVE_STREAM_INGEST_TOKEN and drop --dry-run to push.');
  process.exit(0);
}
if (!TOKEN) fail('MBP_LIVE_STREAM_INGEST_TOKEN env var is required. Use --dry-run to preview without it.');

const res = await fetch(INGEST_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
  body: JSON.stringify({ ...envelope, sha256 }),
}).catch((e) => { fail('network error: ' + e.message); });

const text = await res.text();
let body;
try { body = JSON.parse(text); } catch { body = { raw: text }; }
if (!res.ok) fail('ingest returned HTTP ' + res.status + ' · ' + JSON.stringify(body).slice(0, 300));

const receipt = {
  schema_version: 'xlooop.mbp_projection_push_receipt.v1',
  status: 'PASS',
  pushed_at: new Date().toISOString(),
  target: INGEST_URL,
  projection_file: PROJECTION_FILE,
  manifest_file: MANIFEST_FILE,
  secret_included: false,
  envelope: {
    generated_at: projection.generated_at,
    valid_until: projection.valid_until,
    manifest_valid_until: manifest.valid_until,
    packets: projection.packets.length,
    sha256,
  },
  response: { http_status: res.status, id: body.id || null, freshness: body.freshness || null },
};
mkdirSync(path.dirname(RECEIPT_PATH), { recursive: true });
writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);

console.log('\n✓ ingested · id=' + (body.id || '?') + ' · freshness=' + (body.freshness?.status || '?'));
console.log('✓ receipt  · ' + RECEIPT_PATH);
process.exit(0);
