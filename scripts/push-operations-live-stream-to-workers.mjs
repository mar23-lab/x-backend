#!/usr/bin/env node
// scripts/push-operations-live-stream-to-workers.mjs
//
// R53-W2 · MB-P → Workers push job (operator-side).
//
// WHY: Cloudflare Workers cannot read the operator's local MB-P files, so the
// "operations live stream" can't be pulled server-side. Instead, MB-P PUSHES
// the freshly-generated envelope to the Workers ingest endpoint, which stores
// it in Neon. GET /api/v1/mbp-live-stream then serves the newest DB snapshot
// (source_mode from the envelope, e.g. staged_snapshot) instead of the
// build-time bundle import that only refreshed on redeploy.
//
// RUN (from this repo, on the machine where the MB-P files live):
//   export MBP_LIVE_STREAM_INGEST_TOKEN=<the secret you set on the Worker>
//   node scripts/ensure-operations-live-stream-fresh.mjs   # regenerate the envelope
//   node scripts/push-operations-live-stream-to-workers.mjs
//
// Schedule it (e.g. every 5 min) with launchd/cron to keep the cockpit live.
//
// FLAGS:
//   --dry-run      print payload size + target, do NOT POST (no token needed)
//   --file=<path>  override the envelope source (default data/operations-live-stream.json)
//   --api=<url>    override API base (default $XLOOOP_API_BASE_URL or https://api.xlooop.com)
//
// EXIT: 0 on 2xx receipt; non-zero on any failure (so cron surfaces breakage).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const FILE = flagVal('--file') || path.join(REPO, 'data/operations-live-stream.json');
const API_BASE = (flagVal('--api') || process.env.XLOOOP_API_BASE_URL || 'https://api.xlooop.com').replace(/\/$/, '');
const INGEST_URL = API_BASE + '/api/v1/mbp-live-stream/ingest';
const TOKEN = (process.env.MBP_LIVE_STREAM_INGEST_TOKEN || '').trim();
const RECEIPT_PATH = flagVal('--receipt')
  || process.env.XLOOOP_LIVE_STREAM_PUSH_RECEIPT_PATH
  || path.join(os.homedir(), '.mbp', 'xlooop-live-stream-push-receipt.json');

assertNoReadOnlyVerificationLock('push-operations-live-stream-to-workers');

function fail(msg) {
  console.error('✗ push-operations-live-stream · ' + msg);
  process.exit(1);
}

let envelope;
try {
  envelope = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (e) {
  fail('cannot read envelope at ' + FILE + ' · ' + e.message);
}

if (!envelope || typeof envelope !== 'object' || !Array.isArray(envelope.rows)) {
  fail('envelope at ' + FILE + ' has no rows[] array — run ensure-operations-live-stream-fresh.mjs first');
}
if (!envelope.generated_at) {
  fail('envelope is missing generated_at — not a valid operations-live-stream document');
}

const payload = JSON.stringify(envelope);
const sha256 = createHash('sha256').update(payload).digest('hex');

console.log('push-operations-live-stream-to-workers');
console.log('  source      ' + FILE);
console.log('  target      ' + INGEST_URL);
console.log('  rows        ' + envelope.rows.length);
console.log('  source_mode ' + (envelope.source_mode || '(absent)'));
console.log('  generated   ' + envelope.generated_at);
console.log('  valid_until ' + (envelope.valid_until || '(absent)'));
console.log('  bytes       ' + payload.length);
console.log('  sha256      ' + sha256.slice(0, 16) + '…');

if (DRY_RUN) {
  console.log('\n--dry-run · NOT posting. Set MBP_LIVE_STREAM_INGEST_TOKEN and drop --dry-run to push.');
  process.exit(0);
}

if (!TOKEN) {
  fail('MBP_LIVE_STREAM_INGEST_TOKEN env var is required (the secret set on the Worker). Use --dry-run to preview without it.');
}

const res = await fetch(INGEST_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + TOKEN,
  },
  // Send the bare envelope; the route also accepts { operations_live_stream, sha256 }.
  body: JSON.stringify({ ...envelope, sha256 }),
}).catch((e) => { fail('network error: ' + e.message); });

const text = await res.text();
let body;
try { body = JSON.parse(text); } catch { body = { raw: text }; }

if (!res.ok) {
  fail('ingest returned HTTP ' + res.status + ' · ' + JSON.stringify(body));
}

const receipt = {
  schema_version: 'xlooop.operations_live_stream_push_receipt.v1',
  status: 'PASS',
  pushed_at: new Date().toISOString(),
  target: INGEST_URL,
  source_file: FILE,
  secret_included: false,
  envelope: {
    stream_id: envelope.stream_id || null,
    generated_at: envelope.generated_at,
    valid_until: envelope.valid_until || null,
    source_mode: envelope.source_mode || null,
    rows: envelope.rows.length,
    sha256,
  },
  response: {
    http_status: res.status,
    id: body.id || null,
    rows_count: body.rows_count ?? null,
    generated_at: body.generated_at || null,
  },
};
mkdirSync(path.dirname(RECEIPT_PATH), { recursive: true });
writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);

console.log('\n✓ ingested · id=' + (body.id || '?') + ' · rows=' + (body.rows_count ?? '?') + ' · generated_at=' + (body.generated_at || '?'));
console.log('✓ receipt  · ' + RECEIPT_PATH);
process.exit(0);
