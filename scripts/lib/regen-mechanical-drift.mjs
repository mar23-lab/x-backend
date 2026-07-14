#!/usr/bin/env node
// scripts/lib/regen-mechanical-drift.mjs · Round 15 R15.X (2026-05-20).
//
// Idempotent auto-regen of the two mechanical-drift artifacts that
// every bundle-changing PR has historically had to hand-edit:
//
//   1. `data/visual-verification-morning-addendum.example.json` ·
//      after_c81_bytes + headroom_bytes match current dist/v3-app.js
//
//   2. `docs/REPO-SCHEMA.{md,yaml}` · re-generate via
//      scripts/repo-schema-gen.mjs
//
// Wired into `scripts/build-standalone.mjs` as the FINAL step so every
// `npm run build:standalone` leaves the working tree consistent with
// the bundle. Eliminates the per-PR manual re-stamp friction that
// caused ~5 of 7 R14-Tail PRs to break the verify:current-integrity
// gate post-merge.
//
// Usage:
//   node scripts/lib/regen-mechanical-drift.mjs            # full regen
//   node scripts/lib/regen-mechanical-drift.mjs --dry-run  # report only
//
// Exit codes:
//   0 · regen successful (or nothing to do)
//   1 · regen failed (read/write error)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADDENDUM_PATH = path.join(REPO_ROOT, 'data', 'visual-verification-morning-addendum.example.json');
const APP_BUNDLE_PATH = path.join(REPO_ROOT, 'dist', 'v3-app.js');
const APP_BUNDLE_MAX_BYTES = 1376256; // mirrored from scripts/perf-budget.mjs · v3-app envelope (1344 KiB · 2026-05-30 investor-portal merge)

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function log(msg) { console.log(`regen-mechanical-drift · ${msg}`); }
function warn(msg) { console.warn(`regen-mechanical-drift · WARN · ${msg}`); }

let exitCode = 0;

// --- 1. Visual verification morning addendum ---
function regenVisualAddendum() {
  if (!fs.existsSync(APP_BUNDLE_PATH)) {
    warn(`skipping visual-addendum regen · ${path.relative(REPO_ROOT, APP_BUNDLE_PATH)} does not exist · run \`npm run build:app\` first`);
    return { changed: false, reason: 'no-bundle' };
  }
  const bundleBytes = fs.statSync(APP_BUNDLE_PATH).size;
  const headroomBytes = APP_BUNDLE_MAX_BYTES - bundleBytes;

  if (!fs.existsSync(ADDENDUM_PATH)) {
    warn(`addendum file missing at ${path.relative(REPO_ROOT, ADDENDUM_PATH)} · skipping`);
    return { changed: false, reason: 'no-addendum' };
  }
  const addendumRaw = fs.readFileSync(ADDENDUM_PATH, 'utf8');
  let addendum;
  try {
    addendum = JSON.parse(addendumRaw);
  } catch (err) {
    warn(`addendum parse error · ${err.message}`);
    exitCode = 1;
    return { changed: false, reason: 'parse-error' };
  }
  if (!addendum.bundle) {
    warn(`addendum has no .bundle section · skipping`);
    return { changed: false, reason: 'no-bundle-section' };
  }

  const prev = {
    after_c81_bytes: addendum.bundle.after_c81_bytes,
    headroom_bytes: addendum.bundle.headroom_bytes,
  };
  if (prev.after_c81_bytes === bundleBytes && prev.headroom_bytes === headroomBytes) {
    log(`visual-addendum already fresh · bundle=${bundleBytes} headroom=${headroomBytes}`);
    return { changed: false, reason: 'fresh' };
  }

  if (DRY_RUN) {
    log(`[dry-run] visual-addendum would change · after_c81_bytes ${prev.after_c81_bytes} → ${bundleBytes} · headroom_bytes ${prev.headroom_bytes} → ${headroomBytes}`);
    return { changed: true, reason: 'dry-run' };
  }

  addendum.bundle.after_c81_bytes = bundleBytes;
  addendum.bundle.headroom_bytes = headroomBytes;
  fs.writeFileSync(ADDENDUM_PATH, JSON.stringify(addendum, null, 2) + '\n');
  log(`visual-addendum updated · after_c81_bytes ${prev.after_c81_bytes} → ${bundleBytes} · headroom_bytes ${prev.headroom_bytes} → ${headroomBytes}`);
  return { changed: true, reason: 'updated' };
}

// --- 2. REPO-SCHEMA regen ---
function regenRepoSchema() {
  if (DRY_RUN) {
    log(`[dry-run] would invoke scripts/repo-schema-gen.mjs`);
    return { changed: false, reason: 'dry-run' };
  }
  const result = spawnSync(process.execPath, ['scripts/repo-schema-gen.mjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    warn(`repo-schema-gen failed with exit ${result.status}`);
    if (result.stderr) process.stderr.write(result.stderr);
    exitCode = 1;
    return { changed: false, reason: 'gen-failed' };
  }
  // Print the gen's last line (path counts).
  const out = (result.stdout || '').trim().split('\n').slice(-2).join('\n');
  log(`REPO-SCHEMA regenerated · ${out.split('\n')[0].trim()}`);
  return { changed: true, reason: 'updated' };
}

// --- main ---
const a = regenVisualAddendum();
const b = regenRepoSchema();

log(`done · addendum:${a.reason} · repo-schema:${b.reason}${DRY_RUN ? ' · (dry-run)' : ''}`);
process.exit(exitCode);
