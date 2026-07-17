#!/usr/bin/env node
// verify-mbp-projection-freshness.mjs · 2026-07-17
//
// THE AUTHORITY ON "IS THE STAGED MB-P PROJECTION FRESH AND EXTERNAL-SAFE".
//
// WHY THIS FILE EXISTS NOW AND NOT BEFORE
// It never existed. ensure-mbp-projection-fresh.mjs:62-67 has always spawned
// `node scripts/verify-mbp-projection-freshness.mjs` and treated a non-zero exit as "stale" — and a
// missing module exits 1 (MODULE_NOT_FOUND). So freshnessOk() was hard-wired to FALSE: ensure-
// could never report fresh, and reported a projection valid until TOMORROW as "upstream export is
// itself expired". verify-projection-cron-liveness.mjs:21,88 names this same script as the owner of
// "fail-closed freshness" on the commercial/demo path. Two consumers, no producer. This is the
// producer.
//
// Deliberately narrow: freshness + external-safety of the STAGED pair. Cron liveness is owned by
// verify-projection-cron-liveness.mjs; upstream staging by ensure-mbp-projection-fresh.mjs. This
// answers exactly the question its name asks.
//
// Contract mirrors ensure-mbp-projection-fresh.mjs so the two cannot disagree:
//   * both staged files exist and parse
//   * operation_mode === 'metadata_readonly' AND redaction_state === 'metadata_only'
//   * private_raw_content_included !== true
//   * valid_until parses and is in the future
//
// Exit 0 = fresh. Non-zero = stale/unsafe. Fail closed: anything unparseable is stale.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const PROJECTION = path.join(repoRoot, 'data/mbp-operations-projection.json');
const MANIFEST = path.join(repoRoot, 'data/mbp-projection-export-manifest.json');

function emit(obj) { console.log(JSON.stringify(obj, null, 2)); }
function fail(reason, extra = {}) {
  emit({ schema_version: 'xlooop.mbp_projection_freshness.v1', status: 'FAIL', reason, ...extra });
  process.exit(1);
}
function pass(extra = {}) {
  emit({ schema_version: 'xlooop.mbp_projection_freshness.v1', status: 'PASS', ...extra });
  process.exit(0);
}

for (const [key, file] of [['projection', PROJECTION], ['manifest', MANIFEST]]) {
  if (!fs.existsSync(file)) {
    fail(`Staged ${key} missing`, { expected: file, renewal_command: 'npm run ensure:mbp-projection-fresh' });
  }
}

let projection;
try {
  projection = JSON.parse(fs.readFileSync(PROJECTION, 'utf8'));
} catch (error) {
  fail('Staged projection is not parseable JSON', { file: PROJECTION, error: String(error.message || error) });
}

// External-safety first: stale-but-safe and fresh-but-unsafe are BOTH refusals, and the unsafe one
// is worse. Same predicate as ensure-mbp-projection-fresh.mjs:100-102 — kept identical on purpose so
// the two cannot drift into disagreeing about what "safe" means.
if (projection.operation_mode !== 'metadata_readonly'
  || projection.redaction_state !== 'metadata_only'
  || projection.private_raw_content_included === true) {
  fail('Staged projection is not external-safe (must be metadata_readonly / metadata_only, no raw content)', {
    operation_mode: projection.operation_mode ?? null,
    redaction_state: projection.redaction_state ?? null,
    private_raw_content_included: projection.private_raw_content_included ?? null,
  });
}

const validUntilRaw = projection.valid_until ?? null;
if (!validUntilRaw) fail('Staged projection has no valid_until', { file: PROJECTION });

// The producer stamps an offset-bearing ISO timestamp (e.g. 2026-07-18T11:31:10+10:00). Date.parse
// handles the offset; do NOT hand-roll a string comparison. A timestamp misread as forever-stale is
// a recurring defect in this estate, and this file exists because of a freshness verdict that was
// wrong in exactly that direction.
const validUntilMs = Date.parse(validUntilRaw);
if (Number.isNaN(validUntilMs)) fail('Staged projection valid_until does not parse', { valid_until: validUntilRaw });

const nowMs = Date.now();
if (validUntilMs <= nowMs) {
  fail('Staged MB-P projection has expired', {
    valid_until: validUntilRaw,
    now: new Date(nowMs).toISOString(),
    expired_for_hours: Number(((nowMs - validUntilMs) / 3.6e6).toFixed(2)),
    renewal_command: 'npm run ensure:mbp-projection-fresh',
  });
}

pass({
  valid_until: validUntilRaw,
  remaining_hours: Number(((validUntilMs - nowMs) / 3.6e6).toFixed(2)),
  operation_mode: projection.operation_mode,
  redaction_state: projection.redaction_state,
  generated_at: projection.generated_at ?? null,
  domains_present: Array.isArray(projection.domains) ? projection.domains.length : 0,
  packets_present: Array.isArray(projection.packets) ? projection.packets.length : 0,
});
