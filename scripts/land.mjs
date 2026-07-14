#!/usr/bin/env node
// scripts/land.mjs · the SINGLE safe path to land work on main.
//
// WHY (retro 2026-05-30): this session committed-on-RED and pushed to main 3× — the
// commit+push was batched in the same step as ci-local, so the red result was never read.
// The pre-push hook that would have caught it requires `bash scripts/install-hooks.sh`
// (core.hooksPath), which was NOT installed in the secondary worktree, and direct
// `git push … HEAD:main` bypasses hooks entirely. The structural fix: make the CORRECT
// path the EASY path — one command that (1) runs ci-local and REFUSES on red, (2) acquires
// a parallel-session land-lock so two Claude sessions can't FF-race main, (3) verifies
// fast-forward safety, (4) pushes the branch + FF-lands main, (5) releases the lock.
//
// This makes "commit on red" and "race a parallel session" structurally hard, not
// discipline-dependent — the two process failures the retro identified as the top risk.
//
// Usage:
//   node scripts/land.mjs            · land current branch → origin/main (FF-only)
//   node scripts/land.mjs --no-main  · push the feature branch only, do NOT touch main
//   node scripts/land.mjs --force-unlock · steal a stale lock (prints owner first)
//
// Exit codes: 0 = landed · 1 = blocked (red gate / non-FF / lock held / dirty)

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = resolve(REPO, '.land-lock');
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 min — a land should never take longer
const args = process.argv.slice(2);
const noMain = args.includes('--no-main');
const forceUnlock = args.includes('--force-unlock');

const sh = (cmd, opts = {}) => execSync(cmd, { cwd: REPO, encoding: 'utf8', ...opts }).trim();
const shInherit = (cmd) => execSync(cmd, { cwd: REPO, stdio: 'inherit' });
function die(msg) { console.error(`\n✗ land BLOCKED · ${msg}`); process.exit(1); }
function step(msg) { console.log(`▶ ${msg}`); }

// A stable per-session id so a session can re-enter its own lock (idempotent retries).
function sessionId() {
  // PID of the node process tree root is stable within a session; pair with branch.
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  return `${branch}:${process.ppid || process.pid}`;
}

// ── A3 · parallel-session land-lock ───────────────────────────────────────────
function readLock() {
  if (!existsSync(LOCK)) return null;
  try { return JSON.parse(readFileSync(LOCK, 'utf8')); } catch { return { raw: readFileSync(LOCK, 'utf8') }; }
}
function acquireLock(id, nowMs) {
  const held = readLock();
  if (held) {
    const ageMs = held.at_ms ? (nowMs - held.at_ms) : Infinity;
    const stale = ageMs > LOCK_STALE_MS;
    if (held.id === id) {
      // our own lock — re-enter
    } else if (stale || forceUnlock) {
      console.warn(`  ⚠ stealing ${stale ? 'STALE' : 'force-unlocked'} land-lock held by ${held.id} (age ${Math.round(ageMs / 60000)}m)`);
    } else {
      die(`land-lock held by another session: ${held.id} (age ${Math.round(ageMs / 60000)}m). ` +
        `Another session is landing. Wait, or 'node scripts/land.mjs --force-unlock' if it crashed.`);
    }
  }
  // at_ms is passed in (Date.now from the caller — scripts can't use Date.now at import,
  // but a CLI entrypoint runs once so a single read is fine here via process timing).
  writeFileSync(LOCK, JSON.stringify({ id, at_ms: nowMs, at: new Date(nowMs).toISOString() }, null, 2));
}
function releaseLock(id) {
  const held = readLock();
  if (held && held.id === id) { try { rmSync(LOCK); } catch {} }
}

async function main() {
  const nowMs = Date.now();
  const id = sessionId();
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  if (branch === 'main') die('on main directly — land from a feature branch.');

  // 1 · clean tree (only ignore the known cron-pushed data noise + dist dryrun)
  const dirty = sh('git status --porcelain')
    .split('\n').filter(Boolean)
    .filter((l) => !/operations-live-stream\.json|mbp-gateway-receipts\.json|dist-workers-dryrun/.test(l));
  if (dirty.length) die(`uncommitted changes (commit or stash first):\n  ${dirty.slice(0, 8).join('\n  ')}`);

  acquireLock(id, nowMs);
  try {
    // 2 · GREEN-BEFORE-PUSH — the load-bearing gate. Refuse on red.
    step('ci-local (green-before-push) …');
    try { shInherit('npm run --silent ci-local'); }
    catch { die('ci-local RED — fix the failing gate, then re-land. (This is the guard that was bypassed on 2026-05-30.)'); }

    // 3 · push the feature branch (its own ref)
    step(`push ${branch} → origin/${branch}`);
    shInherit(`git push origin ${branch}`);
    if (noMain) { console.log('\n☑ branch pushed (--no-main: main untouched).'); return; }

    // 4 · FF-safety vs origin/main (fetch first — a parallel session may have landed)
    step('fetch + verify fast-forward safety vs origin/main');
    sh('git fetch origin');
    try { sh('git merge-base --is-ancestor origin/main HEAD'); }
    catch { die('origin/main has advanced — HEAD is not a fast-forward. Reconcile (merge/reset onto origin/main), re-run ci-local, then land again.'); }

    // 5 · FF-land
    step('FF-land → origin/main');
    shInherit('git push origin HEAD:main');
    console.log(`\n☑ landed ${branch} → main (${sh('git rev-parse --short HEAD')})`);
  } finally {
    releaseLock(id);
  }
}

main().catch((e) => { try { releaseLock(sessionId()); } catch {} die(e.message || String(e)); });
