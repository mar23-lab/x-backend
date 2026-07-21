#!/usr/bin/env node
// scripts/reconcile-delta-provenance.mjs · one-command reconcile of MIGRATION-DELTA-PROVENANCE.json.
//
// WHY. Editing a delta-managed file drifts its blob → `verify:provenance` FAILS. Until now the fix was
// a hand-rolled python snippet per PR (recurring friction, error-prone: wrong-length SHAs, missed files,
// heredoc-guard trips). This binds the reconcile into ONE deterministic command so a drifted delta-managed
// file is fixed the same way every time. It ONLY touches files that are ALREADY delta-managed (a NEW file
// is not managed and is skipped with a notice) — so it can never wrongly enroll a file or launder a real
// drift on an unmanaged path.
//
// Use:
//   node scripts/reconcile-delta-provenance.mjs --id <delta-id> --reason "<why>" <file...>
//   node scripts/reconcile-delta-provenance.mjs --self-test        # offline idempotency proof
//
// After running, `npm run verify:provenance` should PASS for the listed files.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DELTA_FILE = join(ROOT, 'MIGRATION-DELTA-PROVENANCE.json');
const SEED_FILE = join(ROOT, 'MIGRATION-PROVENANCE.json');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** The set of paths that are delta-managed today (seed transformed/copied + every delta's files). */
function managedPaths(delta, seed) {
  const s = new Set();
  const collect = (obj) => {
    for (const key of ['transformed_files', 'copied_files']) {
      for (const f of obj?.[key] ?? []) if (f?.path) s.add(f.path);
    }
  };
  collect(seed);
  for (const d of delta.deltas ?? []) collect(d);
  return s;
}

function reconcile(deltaJson, seedJson, { id, reason, files, sourceCommit, nowIso }) {
  const managed = managedPaths(deltaJson, seedJson);
  const transformed = [];
  const skipped = [];
  for (const path of files) {
    if (!managed.has(path)) { skipped.push(path); continue; }
    const blob = git(['hash-object', path]);
    transformed.push({ path, target_blob: blob, reason: reason || `reconcile ${id}` });
  }
  if (transformed.length === 0) {
    return { changed: false, skipped, transformed };
  }
  const delta = {
    delta_id: id,
    generated_at: nowIso,
    source_repo: 'mar23-lab/x-backend',
    source_commit: sourceCommit,
    target_base_commit: sourceCommit,
    authority: 'shadow_only_no_production_cutover',
    copied_files: [],
    transformed_files: transformed,
  };
  deltaJson.deltas = (deltaJson.deltas ?? []).filter((d) => d.delta_id !== id);
  deltaJson.deltas.push(delta);
  return { changed: true, skipped, transformed, deltaCount: deltaJson.deltas.length };
}

function selfTest() {
  // Idempotency: applying the same reconcile twice yields ONE delta, not two; blobs are 40-char.
  const seed = { transformed_files: [{ path: 'a.ts' }] };
  const dj = { deltas: [{ delta_id: 'x', transformed_files: [{ path: 'a.ts', target_blob: 'old', reason: 'r' }] }] };
  const nowIso = new Date().toISOString();
  const r1 = reconcileWith(dj, seed, { id: 'x', reason: 'r2', files: ['a.ts'], sourceCommit: 'c'.repeat(40), nowIso, hash: () => 'b'.repeat(40) });
  const r2 = reconcileWith(dj, seed, { id: 'x', reason: 'r2', files: ['a.ts'], sourceCommit: 'c'.repeat(40), nowIso, hash: () => 'b'.repeat(40) });
  const okOne = dj.deltas.filter((d) => d.delta_id === 'x').length === 1;
  const okBlob = dj.deltas.find((d) => d.delta_id === 'x').transformed_files[0].target_blob === 'b'.repeat(40);
  const okSkip = reconcileWith(dj, seed, { id: 'y', reason: 'r', files: ['new.ts'], sourceCommit: 'c'.repeat(40), nowIso, hash: () => 'z' }).skipped.includes('new.ts');
  const ok = okOne && okBlob && okSkip && r1.changed && r2.changed;
  console.log(`  self-test: single-delta=${okOne} blob-updated=${okBlob} unmanaged-skipped=${okSkip}`);
  console.log(ok ? 'PASS reconcile-delta-provenance self-test' : 'FAIL reconcile-delta-provenance self-test');
  return ok ? 0 : 1;
}

// test-only variant that injects the hash fn (avoids invoking real git in the self-test)
function reconcileWith(deltaJson, seedJson, { id, reason, files, sourceCommit, nowIso, hash }) {
  const managed = managedPaths(deltaJson, seedJson);
  const transformed = [];
  const skipped = [];
  for (const path of files) {
    if (!managed.has(path)) { skipped.push(path); continue; }
    transformed.push({ path, target_blob: hash(path), reason: reason || `reconcile ${id}` });
  }
  if (transformed.length) {
    const delta = { delta_id: id, generated_at: nowIso, source_repo: 'mar23-lab/x-backend', source_commit: sourceCommit, target_base_commit: sourceCommit, authority: 'shadow_only_no_production_cutover', copied_files: [], transformed_files: transformed };
    deltaJson.deltas = (deltaJson.deltas ?? []).filter((d) => d.delta_id !== id);
    deltaJson.deltas.push(delta);
  }
  return { changed: transformed.length > 0, skipped, transformed };
}

// ---- CLI ----
const argv = process.argv.slice(2);
if (argv.includes('--self-test')) process.exit(selfTest());

function opt(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
const id = opt('--id');
const reason = opt('--reason');
const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--id' && argv[i - 1] !== '--reason');
if (!id || files.length === 0) {
  console.error('usage: reconcile-delta-provenance.mjs --id <delta-id> --reason "<why>" <file...>');
  process.exit(2);
}

const deltaJson = JSON.parse(readFileSync(DELTA_FILE, 'utf8'));
const seedJson = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
const res = reconcile(deltaJson, seedJson, { id, reason, files, sourceCommit: git(['rev-parse', 'HEAD']), nowIso: new Date().toISOString() });

for (const p of res.skipped) console.log(`  notice: ${p} is NOT delta-managed (new/unmanaged file) — skipped, no reconcile needed.`);
if (!res.changed) { console.log('nothing to reconcile (all listed files are unmanaged).'); process.exit(0); }
writeFileSync(DELTA_FILE, JSON.stringify(deltaJson, null, 2) + '\n');
console.log(`reconciled delta '${id}': ${res.transformed.length} file(s); ${res.deltaCount} delta(s) total. Run: npm run verify:provenance`);
