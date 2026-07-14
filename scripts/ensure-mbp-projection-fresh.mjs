#!/usr/bin/env node
// ensure-mbp-projection-fresh — keep the staged MB-P operations projection fresh.
//
// WHY THIS EXISTS
// The MB-P side (export_mbp_to_xlooop_projection.py, cron-driven) regenerates a
// metadata-safe / external-safe projection into
//   <MBP_ROOT>/_sys/xcp-system/cross_repo_drafts/Xlooop-XCP-demo/data/
// The consumer step — staging that file into Xlooop-XCP-demo/data/ — was MANUAL
// and had no automated trigger, so the projection silently expired (24h window)
// and the commercial-demo-readiness gate went no_go on three "projection
// freshness" blockers even though a FRESH external-safe export already existed
// upstream. `commercial:preflight` refreshed the operations-live-stream snapshot
// but NOT the projection (ensure-operations-live-stream-fresh returns early when
// the stream is fresh, so its `poll` step — which also omits the projection —
// never ran). This script closes that gap: it is the projection analog of
// ensure-operations-live-stream-fresh and is wired into commercial:preflight.
//
// SAFETY
// - Stages ONLY external-safe projections (operation_mode=metadata_readonly,
//   redaction_state=metadata_only, private_raw_content_included!==true). An
//   --internal-full (owner-approved raw-excerpt) export is REFUSED — this script
//   never moves raw MB-P content into the consumer repo.
// - Read-only honoring: XCP_VERIFY_READONLY=1 refuses to write tracked artifacts.
// - It does NOT generate the projection (that is the MB-P side's boundary); if the
//   upstream export is itself stale/missing it FAILS with a clear hint to run the
//   MB-P export, rather than staging stale data.
//
// USAGE
//   node scripts/ensure-mbp-projection-fresh.mjs           # refresh if stale
//   node scripts/ensure-mbp-projection-fresh.mjs --check   # fail (no refresh) if stale

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const mbpRoot = process.env.MBP_ROOT || '/Users/maratbasyrov/WIP/MB-P';
const srcDir = path.join(mbpRoot, '_sys/xcp-system/cross_repo_drafts/Xlooop-XCP-demo/data');
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const readOnly = process.env.XCP_VERIFY_READONLY === '1';

const FILES = [
  { src: path.join(srcDir, 'mbp-operations-projection.json'), dst: path.join(repoRoot, 'data/mbp-operations-projection.json'), key: 'projection' },
  { src: path.join(srcDir, 'mbp-projection-export-manifest.json'), dst: path.join(repoRoot, 'data/mbp-projection-export-manifest.json'), key: 'manifest' },
];

function emit(obj) { console.log(JSON.stringify(obj, null, 2)); }
function fail(reason, extra = {}) {
  emit({ schema_version: 'xlooop.mbp_projection_freshness.v1', status: 'FAIL', reason, ...extra });
  process.exit(1);
}
function pass(extra = {}) {
  emit({ schema_version: 'xlooop.mbp_projection_freshness.v1', status: 'PASS', ...extra });
  process.exit(0);
}

// Authority on "fresh" = the same verifier the commercial gate runs, so this can
// never disagree with the gate.
function freshnessOk() {
  const r = spawnSync('node', [path.join(repoRoot, 'scripts/verify-mbp-projection-freshness.mjs')], {
    cwd: repoRoot, encoding: 'utf8',
  });
  return (r.status ?? 1) === 0;
}

// 1) Already fresh → nothing to do.
if (freshnessOk()) pass({ refreshed: false, detail: 'staged MB-P projection already fresh' });

if (checkOnly) {
  fail('MB-P projection stale and --check forbids refresh', {
    blocker_id: 'mbp_projection_stale',
    renewal_command: 'npm run ensure:mbp-projection-fresh',
  });
}
if (readOnly) {
  fail('MB-P projection stale and XCP_VERIFY_READONLY forbids refreshing tracked artifacts', {
    blocker_id: 'mbp_projection_stale_readonly',
    renewal_command: 'npm run commercial:preflight',
  });
}

// 2) Stage the fresh external-safe export from MB-P cross_repo_drafts.
if (!fs.existsSync(FILES[0].src)) {
  fail('No MB-P projection export found upstream; cannot stage', {
    expected: FILES[0].src,
    hint: 'Run `python3 _sys/scripts/export_mbp_to_xlooop_projection.py` on the MB-P side (or its cron) first.',
  });
}

let projection;
try {
  projection = JSON.parse(fs.readFileSync(FILES[0].src, 'utf8'));
} catch (e) {
  fail('Upstream projection export is not valid JSON', { expected: FILES[0].src, error: String(e && e.message || e) });
}

// REFUSE anything that is not the external-safe metadata projection.
if (projection.operation_mode !== 'metadata_readonly'
  || projection.redaction_state !== 'metadata_only'
  || projection.private_raw_content_included === true) {
  fail('Refusing to stage a non-external-safe projection (must be metadata_readonly / metadata_only, no raw content)', {
    operation_mode: projection.operation_mode ?? null,
    redaction_state: projection.redaction_state ?? null,
    private_raw_content_included: projection.private_raw_content_included ?? null,
  });
}

for (const f of FILES) {
  if (!fs.existsSync(f.src)) fail(`Missing upstream ${f.key} file`, { expected: f.src });
  fs.mkdirSync(path.dirname(f.dst), { recursive: true });
  fs.copyFileSync(f.src, f.dst);
  console.error(`ensure-mbp-projection-fresh · staged ${path.relative(repoRoot, f.dst)} · valid_until ${projection.valid_until}`);
}

// 3) Re-verify against the gate's own freshness verifier.
if (!freshnessOk()) {
  fail('MB-P projection still stale after staging (upstream export is itself expired)', {
    upstream_valid_until: projection.valid_until ?? null,
    hint: 'Regenerate upstream via export_mbp_to_xlooop_projection.py, then re-run.',
  });
}

pass({ refreshed: true, valid_until: projection.valid_until, mode: projection.operation_mode });
