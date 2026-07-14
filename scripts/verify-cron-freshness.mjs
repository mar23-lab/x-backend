#!/usr/bin/env node
// scripts/verify-cron-freshness.mjs · R-J-S2 (260602)
//
// WHY THIS EXISTS: the 260602 architecture audit found that the livestream-push
// cron had been silently writing to the wrong repo (-r50 sibling) for weeks,
// leaving data/operations-live-stream.json 22.9h stale — 91× the 15-minute SLA.
// No automated system detected this; the only signal was the "stale (22h ago)"
// badge in the UI. This gate converts that silent class of failure into a loud
// pre-deploy assertion.
//
// What it checks:
//   1. data/operations-live-stream.json exists and has a parseable generated_at.
//   2. generated_at is WITHIN the configured freshness window (default: 2× push
//      interval = 600s = 10 minutes). If the cron is healthy, the file is never
//      more than one push cycle old.
//   3. valid_until (if present) is in the future.
//
// Freshness window is configurable:
//   VERIFY_CRON_FRESHNESS_MAX_AGE_SECONDS=900 node scripts/verify-cron-freshness.mjs
//
// Exit: 0 = PASS (fresh), 1 = FAIL (stale or missing). Use in:
//   - make verify-cron-freshness  (add to verify-product aggregator)
//   - npx wrangler deploy pre-flight (optional)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STREAM_PATH = path.join(REPO_ROOT, 'data', 'operations-live-stream.json');
const RECEIPT_PATH = process.env.XLOOOP_LIVE_STREAM_PUSH_RECEIPT_PATH
  || path.join(os.homedir(), '.mbp', 'xlooop-live-stream-push-receipt.json');

// 2× push interval (plist StartInterval=300s); configurable via env.
const MAX_AGE_SECONDS = parseInt(process.env.VERIFY_CRON_FRESHNESS_MAX_AGE_SECONDS || '600', 10);

console.log('verify-cron-freshness · R-J-S2 (260602)\n');
console.log(`  threshold:  ${MAX_AGE_SECONDS}s (${(MAX_AGE_SECONDS / 60).toFixed(1)} min)`);
console.log(`  receipt:    ${RECEIPT_PATH}`);

const receipt = readOptionalReceipt();
if (receipt) verifyPushReceipt(receipt);

// ── Gate 1: file exists ──────────────────────────────────────────────────────
if (!existsSync(STREAM_PATH)) {
  console.error(`\n  ✗ FAIL: data/operations-live-stream.json missing at ${STREAM_PATH}`);
  console.error('  → Run scripts/livestream-push-cron.sh manually to generate the file.');
  process.exit(1);
}

// ── Gate 2: parse + extract timestamps ──────────────────────────────────────
let stream;
try {
  stream = JSON.parse(readFileSync(STREAM_PATH, 'utf8'));
} catch (err) {
  console.error(`\n  ✗ FAIL: could not parse operations-live-stream.json: ${err.message}`);
  process.exit(1);
}

const generatedAt = stream.generated_at || (stream._meta && stream._meta.generated_at);
const validUntil = stream.valid_until || null;

if (!generatedAt) {
  console.error('\n  ✗ FAIL: operations-live-stream.json has no generated_at field');
  process.exit(1);
}

const generatedTs = Date.parse(generatedAt);
if (!Number.isFinite(generatedTs)) {
  console.error(`\n  ✗ FAIL: generated_at is not a valid ISO timestamp: ${generatedAt}`);
  process.exit(1);
}

// ── Gate 3: freshness check ──────────────────────────────────────────────────
const nowMs = Date.now();
const ageSeconds = Math.round((nowMs - generatedTs) / 1000);
const ageStr = ageSeconds < 60 ? `${ageSeconds}s` : `${Math.round(ageSeconds / 60)}m ${ageSeconds % 60}s`;

console.log(`  generated:  ${generatedAt}`);
console.log(`  valid_until: ${validUntil || '(absent)'}`);
console.log(`  age:        ${ageStr} (${ageSeconds}s)`);
console.log(`  sla_mult:   ${(ageSeconds / 900).toFixed(1)}× (15min SLA)`);

if (ageSeconds > MAX_AGE_SECONDS) {
  const overBy = ageSeconds - MAX_AGE_SECONDS;
  console.error(`\n  ✗ FAIL: snapshot is ${ageStr} old — exceeds ${MAX_AGE_SECONDS}s threshold by ${overBy}s (${(overBy / 60).toFixed(1)} min)`);
  console.error('  → Is the launchd agent running? Check: launchctl list | grep com.xlooop.livestream');
  console.error('  → Manual trigger: bash scripts/livestream-push-cron.sh');
  console.error(`  → Cron script path: ${path.join(REPO_ROOT, 'scripts', 'livestream-push-cron.sh')}`);
  process.exit(1);
}

// ── Gate 4: valid_until not expired (if present) ────────────────────────────
if (validUntil) {
  const validUntilTs = Date.parse(validUntil);
  if (Number.isFinite(validUntilTs) && validUntilTs < nowMs) {
    const expiredAgo = Math.round((nowMs - validUntilTs) / 60000);
    console.error(`\n  ✗ FAIL: valid_until ${validUntil} expired ${expiredAgo} minutes ago`);
    process.exit(1);
  }
}

console.log('\n  ☑ PASS: cron freshness within threshold');
console.log(`verify-cron-freshness · PASS · snapshot ${ageStr} old (threshold ${MAX_AGE_SECONDS}s)`);
process.exit(0);

function readOptionalReceipt() {
  if (!existsSync(RECEIPT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
  } catch (err) {
    console.error(`\n  ✗ FAIL: could not parse live-stream push receipt: ${err.message}`);
    process.exit(1);
  }
}

function verifyPushReceipt(value) {
  const pushedAt = value.pushed_at || value.generated_at;
  const envelopeGeneratedAt = value.envelope?.generated_at || value.response?.generated_at;
  const validUntil = value.envelope?.valid_until || null;
  const sourceMode = value.envelope?.source_mode || null;
  const rows = Number(value.envelope?.rows || value.response?.rows_count || 0);

  console.log('  source:     runtime push receipt');
  console.log(`  pushed:     ${pushedAt || '(absent)'}`);
  console.log(`  generated:  ${envelopeGeneratedAt || '(absent)'}`);
  console.log(`  valid_until: ${validUntil || '(absent)'}`);
  console.log(`  source_mode: ${sourceMode || '(absent)'}`);
  console.log(`  rows:       ${rows || 0}`);

  if (value.status !== 'PASS') {
    console.error(`\n  ✗ FAIL: live-stream push receipt status is ${value.status || '(absent)'}`);
    process.exit(1);
  }
  if (!pushedAt || !Number.isFinite(Date.parse(pushedAt))) {
    console.error(`\n  ✗ FAIL: live-stream push receipt has invalid pushed_at: ${pushedAt || '(absent)'}`);
    process.exit(1);
  }
  if (!envelopeGeneratedAt || !Number.isFinite(Date.parse(envelopeGeneratedAt))) {
    console.error(`\n  ✗ FAIL: live-stream push receipt has invalid envelope generated_at: ${envelopeGeneratedAt || '(absent)'}`);
    process.exit(1);
  }
  if (sourceMode !== 'staged_snapshot') {
    console.error(`\n  ✗ FAIL: live-stream push receipt source_mode is ${sourceMode || '(absent)'}, expected staged_snapshot`);
    process.exit(1);
  }
  if (!Number.isFinite(rows) || rows <= 0) {
    console.error(`\n  ✗ FAIL: live-stream push receipt has no rows`);
    process.exit(1);
  }

  const nowMs = Date.now();
  const pushAgeSeconds = Math.round((nowMs - Date.parse(pushedAt)) / 1000);
  const envelopeAgeSeconds = Math.round((nowMs - Date.parse(envelopeGeneratedAt)) / 1000);
  const pushAgeStr = formatAge(pushAgeSeconds);
  const envelopeAgeStr = formatAge(envelopeAgeSeconds);

  console.log(`  push_age:   ${pushAgeStr} (${pushAgeSeconds}s)`);
  console.log(`  envelope_age: ${envelopeAgeStr} (${envelopeAgeSeconds}s)`);
  console.log(`  sla_mult:   ${(pushAgeSeconds / 900).toFixed(1)}× (15min SLA)`);

  if (pushAgeSeconds > MAX_AGE_SECONDS) {
    failStale('push receipt', pushAgeStr, pushAgeSeconds);
  }
  if (envelopeAgeSeconds > MAX_AGE_SECONDS) {
    failStale('pushed envelope', envelopeAgeStr, envelopeAgeSeconds);
  }

  if (validUntil) {
    const validUntilTs = Date.parse(validUntil);
    if (Number.isFinite(validUntilTs) && validUntilTs < nowMs) {
      const expiredAgo = Math.round((nowMs - validUntilTs) / 60000);
      console.error(`\n  ✗ FAIL: valid_until ${validUntil} expired ${expiredAgo} minutes ago`);
      process.exit(1);
    }
  }

  console.log('\n  ☑ PASS: cron freshness within threshold');
  console.log(`verify-cron-freshness · PASS · runtime push receipt ${pushAgeStr} old (threshold ${MAX_AGE_SECONDS}s)`);
  process.exit(0);
}

function formatAge(seconds) {
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m ${seconds % 60}s`;
}

function failStale(label, ageStrValue, ageSecondsValue) {
  const overBy = ageSecondsValue - MAX_AGE_SECONDS;
  console.error(`\n  ✗ FAIL: ${label} is ${ageStrValue} old — exceeds ${MAX_AGE_SECONDS}s threshold by ${overBy}s (${(overBy / 60).toFixed(1)} min)`);
  console.error('  → Is the launchd agent running? Check: launchctl list | grep com.xlooop.livestream');
  console.error('  → Manual trigger: bash scripts/livestream-push-cron.sh');
  console.error(`  → Cron script path: ${path.join(REPO_ROOT, 'scripts', 'livestream-push-cron.sh')}`);
  process.exit(1);
}
