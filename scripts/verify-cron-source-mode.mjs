#!/usr/bin/env node
// scripts/verify-cron-source-mode.mjs
//
// Wave R-K Stage 0a (260602) · Cron source_mode integrity gate.
//
// WHY: The source_mode: staged_snapshot rename (Wave R-J) has regressed TWICE.
// Root cause: the cron sometimes fetches the Workers KV cache which may still
// hold the old value. This gate catches the regression immediately so it never
// reaches a deploy or a session start.
//
// What this checks:
//   1. data/operations-live-stream.json.source_mode === 'staged_snapshot'
//   2. The value is NOT 'live_mbp_read_model' (the old pre-rename value)
//   3. The generated_at is within the expected freshness window (≤ 4h + margin)
//
// Wire: add to package.json "verify:cron-source-mode" and include in verify:stability-suite.
//
// Exit: 0 = PASS, 1 = FAIL.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const STREAM_PATH = path.join(REPO_ROOT, 'data', 'operations-live-stream.json');

const EXPECTED_SOURCE_MODE = 'staged_snapshot';
const FORBIDDEN_SOURCE_MODE = 'live_mbp_read_model';
const MAX_AGE_SECONDS = parseInt(process.env.VERIFY_CRON_SOURCE_MODE_MAX_AGE_SECONDS || '14400', 10); // 4h default

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ☑ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

console.log('verify-cron-source-mode · Wave R-K\n');

if (!existsSync(STREAM_PATH)) {
  console.error('  ✗ data/operations-live-stream.json missing');
  process.exit(1);
}

let stream;
try {
  stream = JSON.parse(readFileSync(STREAM_PATH, 'utf8'));
} catch (e) {
  console.error(`  ✗ Failed to parse data/operations-live-stream.json: ${e.message}`);
  process.exit(1);
}

const sourceMode = stream.source_mode;
const generatedAt = stream.generated_at;
const validUntil = stream.valid_until;

check(
  `source_mode is '${EXPECTED_SOURCE_MODE}' (not '${FORBIDDEN_SOURCE_MODE}')`,
  sourceMode === EXPECTED_SOURCE_MODE,
  `actual: '${sourceMode}'`,
);

check(
  `source_mode is not the forbidden pre-rename value`,
  sourceMode !== FORBIDDEN_SOURCE_MODE,
  `found '${FORBIDDEN_SOURCE_MODE}' — cron regression detected`,
);

if (generatedAt) {
  const generated = Date.parse(generatedAt);
  const ageSeconds = Math.round((Date.now() - generated) / 1000);
  check(
    `snapshot age ≤ ${MAX_AGE_SECONDS}s (actual: ${ageSeconds}s)`,
    ageSeconds <= MAX_AGE_SECONDS,
    `snapshot is ${ageSeconds}s old, threshold ${MAX_AGE_SECONDS}s — run: bash scripts/livestream-push-cron.sh`,
  );
} else {
  check('generated_at field present', false, 'missing generated_at in snapshot');
}

if (validUntil) {
  const until = Date.parse(validUntil);
  check(
    `valid_until is in the future`,
    until > Date.now(),
    `valid_until: ${validUntil}`,
  );
} else {
  check('valid_until field present', false, 'missing valid_until in snapshot');
}

console.log(`\nverify-cron-source-mode · ${failed === 0 ? 'PASS' : 'FAIL'} · ${passed}/${passed + failed} passed`);

if (failed > 0) {
  console.error(`\n${failed} failure(s).`);
  console.error('To fix source_mode regression: node scripts/generate-operations-live-stream.mjs && bash scripts/livestream-push-cron.sh');
  process.exit(1);
}
process.exit(0);
