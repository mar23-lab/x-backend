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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DELTA_FILE = join(ROOT, 'MIGRATION-DELTA-PROVENANCE.json');
const SEED_FILE = join(ROOT, 'MIGRATION-PROVENANCE.json');
const CURRENT_AUTHORITY = 'source_authority_no_automatic_deploy';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** The set of paths that are delta-managed today (seed transformed/copied + every delta's files). */
function managedPaths(delta, seed) {
  const s = new Set();
  const collect = (obj) => {
    for (const f of obj?.files ?? []) {
      if (f?.path) s.add(f.path);
    }
    for (const key of ['transformed_files', 'copied_files']) {
      for (const f of obj?.[key] ?? []) {
        const path = typeof f === 'string' ? f : f?.path;
        if (path) s.add(path);
      }
    }
  };
  collect(seed);
  for (const d of delta.deltas ?? []) collect(d);
  return s;
}

function mergePathEntries(existing = [], incoming = []) {
  const merged = new Map();
  for (const entry of existing) if (entry?.path) merged.set(entry.path, entry);
  for (const entry of incoming) if (entry?.path) merged.set(entry.path, entry);
  return [...merged.values()];
}

// RETIREMENT (--deleted, 260729). Deleting a delta-managed file used to be INEXPRESSIBLE: the
// verifier kept expecting the path and reported `missing` forever, so the only routes were a
// hand-edit of the receipt (forbidden) or abandoning a correct deletion. A control with no
// sanctioned path for a legitimate operation is itself a defect.
//
// The retirement is deliberately ITS OWN FLAG. Recording a deletion is destructive to the ledger's
// coverage of that path, so it must be stated, never inferred from a path that happens to be absent
// — a typo'd filename in the normal argument list must remain a harmless "not delta-managed" notice
// rather than a silent retirement. Retirement is also refused unless the file is genuinely gone from
// BOTH the working tree and the index, so it can never launder a still-present file out of the
// ledger.
//
// ADDITIVE: with no --deleted arguments, `seed_exclusions` is not emitted at all and the output is
// byte-identical to before.
function retire(managed, deletedFiles, { id, reason, exists, tracked, originalBlob }) {
  const exclusions = [];
  const refusals = [];
  for (const path of deletedFiles) {
    if (!managed.has(path)) { refusals.push(`${path}: not delta-managed — nothing to retire`); continue; }
    if (exists(path)) { refusals.push(`${path}: still present in the working tree — delete it first, or do not pass --deleted`); continue; }
    if (tracked(path)) { refusals.push(`${path}: still tracked by git — \`git rm\` it first, or do not pass --deleted`); continue; }
    // The receipt must say WHAT was retired, not merely that something was. Without the original
    // blob a retirement is an unfalsifiable claim, so a path whose prior blob cannot be recovered is
    // refused rather than recorded with a placeholder.
    const blob = originalBlob(path);
    if (!/^[0-9a-f]{40}$/.test(blob || '')) {
      refusals.push(`${path}: cannot recover the blob it had before deletion — retire it in the same commit range where it still existed`);
      continue;
    }
    exclusions.push({ path, source_blob: blob, reason: reason || `retired by ${id}` });
  }
  return { exclusions, refusals };
}

/** The blob a path last carried: the ledger's own record first, else the blob committed at HEAD. */
function lastKnownBlob(deltaJson, seedJson, path) {
  let found = null;
  const scan = (obj) => {
    for (const entry of obj?.files ?? []) if (entry?.path === path && entry.source_blob) found = entry.source_blob;
    for (const entry of obj?.transformed_files ?? []) if (entry?.path === path && entry.target_blob) found = entry.target_blob;
    for (const entry of obj?.copied_files ?? []) if (entry?.path === path && entry.source_blob) found = entry.source_blob;
  };
  scan(seedJson);
  for (const delta of deltaJson.deltas ?? []) scan(delta);
  if (found) return found;
  try { return git(['rev-parse', `HEAD:${path}`]); } catch { return null; }
}

function reconcile(deltaJson, seedJson, { id, reason, files, deletedFiles = [], sourceCommit, nowIso }) {
  const managed = managedPaths(deltaJson, seedJson);
  const transformed = [];
  const skipped = [];
  for (const path of files) {
    if (!managed.has(path)) { skipped.push(path); continue; }
    const blob = git(['hash-object', path]);
    transformed.push({ path, target_blob: blob, reason: reason || `reconcile ${id}` });
  }

  const trackedPaths = new Set(git(['ls-files']).split('\n').filter(Boolean));
  const { exclusions, refusals } = retire(managed, deletedFiles, {
    id,
    reason,
    exists: (path) => existsSync(join(ROOT, path)),
    tracked: (path) => trackedPaths.has(path),
    originalBlob: (path) => lastKnownBlob(deltaJson, seedJson, path),
  });
  if (refusals.length) return { changed: false, skipped, transformed, exclusions: [], refusals };

  if (transformed.length === 0 && exclusions.length === 0) {
    return { changed: false, skipped, transformed, exclusions, refusals };
  }
  const prior = (deltaJson.deltas ?? []).find((d) => d.delta_id === id);
  const mergedTransformed = mergePathEntries(prior?.transformed_files, transformed);
  const mergedExclusions = mergePathEntries(prior?.seed_exclusions, exclusions);
  const delta = {
    delta_id: id,
    generated_at: nowIso,
    source_repo: 'mar23-lab/x-backend',
    source_commit: sourceCommit,
    target_base_commit: sourceCommit,
    authority: CURRENT_AUTHORITY,
    copied_files: prior?.copied_files ?? [],
    transformed_files: mergedTransformed,
  };
  // Emitted ONLY when a retirement was actually requested, so existing reconciles are unchanged.
  if (mergedExclusions.length) delta.seed_exclusions = mergedExclusions;
  deltaJson.deltas = (deltaJson.deltas ?? []).filter((d) => d.delta_id !== id);
  deltaJson.deltas.push(delta);
  return { changed: true, skipped, transformed, exclusions, refusals, deltaCount: deltaJson.deltas.length };
}

function selfTest() {
  // Idempotency: applying the same reconcile twice yields ONE delta, not two; blobs are 40-char.
  const seed = {
    files: [{ path: 'seed.ts' }],
    transformed_files: ['transformed.ts'],
  };
  const dj = { deltas: [{ delta_id: 'x', transformed_files: [{ path: 'a.ts', target_blob: 'old', reason: 'r' }] }] };
  const nowIso = new Date().toISOString();
  const files = ['a.ts', 'seed.ts', 'transformed.ts'];
  const r1 = reconcileWith(dj, seed, { id: 'x', reason: 'r2', files, sourceCommit: 'c'.repeat(40), nowIso, hash: () => 'b'.repeat(40) });
  const r2 = reconcileWith(dj, seed, { id: 'x', reason: 'r3', files: ['a.ts'], sourceCommit: 'c'.repeat(40), nowIso, hash: () => 'b'.repeat(40) });
  const okOne = dj.deltas.filter((d) => d.delta_id === 'x').length === 1;
  const reconciled = dj.deltas.find((d) => d.delta_id === 'x').transformed_files;
  const okBlob = reconciled.length === files.length && reconciled.every((entry) => entry.target_blob === 'b'.repeat(40));
  const okAuthority = dj.deltas.find((d) => d.delta_id === 'x').authority === CURRENT_AUTHORITY;
  const okSkip = reconcileWith(dj, seed, { id: 'y', reason: 'r', files: ['new.ts'], sourceCommit: 'c'.repeat(40), nowIso, hash: () => 'z' }).skipped.includes('new.ts');

  // ---- RETIREMENT CONTROLS (--deleted) ----
  // A retirement is destructive to the ledger's coverage of a path, so each refusal below is the
  // point of the feature, not an edge case.
  const managedForRetire = managedPaths({ deltas: [{ transformed_files: [{ path: 'gone.ts' }, { path: 'still-here.ts' }] }] }, seed);
  const absent = () => false;
  const untracked = () => false;
  const knownBlob = () => 'd'.repeat(40);

  const happy = retire(managedForRetire, ['gone.ts'], { id: 'x', reason: 'retired', exists: absent, tracked: untracked, originalBlob: knownBlob });
  const okRetire = happy.exclusions.length === 1 && happy.exclusions[0].path === 'gone.ts'
    && happy.exclusions[0].source_blob === 'd'.repeat(40) && happy.refusals.length === 0;

  const stillOnDisk = retire(managedForRetire, ['still-here.ts'], { id: 'x', reason: 'r', exists: (p) => p === 'still-here.ts', tracked: untracked, originalBlob: knownBlob });
  const okRefuseOnDisk = stillOnDisk.exclusions.length === 0 && stillOnDisk.refusals.length === 1;

  const stillTracked = retire(managedForRetire, ['still-here.ts'], { id: 'x', reason: 'r', exists: absent, tracked: (p) => p === 'still-here.ts', originalBlob: knownBlob });
  const okRefuseTracked = stillTracked.exclusions.length === 0 && stillTracked.refusals.length === 1;

  const unmanagedRetire = retire(managedForRetire, ['never-managed.ts'], { id: 'x', reason: 'r', exists: absent, tracked: untracked, originalBlob: knownBlob });
  const okRefuseUnmanaged = unmanagedRetire.exclusions.length === 0 && unmanagedRetire.refusals.length === 1;

  const noBlob = retire(managedForRetire, ['gone.ts'], { id: 'x', reason: 'r', exists: absent, tracked: untracked, originalBlob: () => null });
  const okRefuseNoBlob = noBlob.exclusions.length === 0 && noBlob.refusals.length === 1;

  // ADDITIVE PROOF: a reconcile with NO --deleted must not grow a seed_exclusions key. If this ever
  // fails, every existing caller's output has changed shape.
  const okAdditive = !Object.prototype.hasOwnProperty.call(dj.deltas.find((d) => d.delta_id === 'x'), 'seed_exclusions');

  const ok = okOne && okBlob && okAuthority && okSkip && r1.changed && r2.changed
    && okRetire && okRefuseOnDisk && okRefuseTracked && okRefuseUnmanaged && okRefuseNoBlob && okAdditive;
  console.log(`  self-test: single-delta=${okOne} partial-repeat-preserves-full-set=${okBlob} current-authority=${okAuthority} unmanaged-skipped=${okSkip}`);
  console.log(`  self-test: retire=${okRetire} refuse-on-disk=${okRefuseOnDisk} refuse-tracked=${okRefuseTracked} refuse-unmanaged=${okRefuseUnmanaged} refuse-no-blob=${okRefuseNoBlob} additive-no-key=${okAdditive}`);
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
    const prior = (deltaJson.deltas ?? []).find((d) => d.delta_id === id);
    const delta = { delta_id: id, generated_at: nowIso, source_repo: 'mar23-lab/x-backend', source_commit: sourceCommit, target_base_commit: sourceCommit, authority: CURRENT_AUTHORITY, copied_files: prior?.copied_files ?? [], transformed_files: mergePathEntries(prior?.transformed_files, transformed) };
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
// Everything AFTER --deleted is a retirement; everything before it keeps the original semantics, so
// an invocation without --deleted parses exactly as it always did.
const deletedAt = argv.indexOf('--deleted');
const head = deletedAt >= 0 ? argv.slice(0, deletedAt) : argv;
const deletedFiles = deletedAt >= 0 ? argv.slice(deletedAt + 1).filter((a) => !a.startsWith('--')) : [];
const files = head.filter((a, i) => !a.startsWith('--') && head[i - 1] !== '--id' && head[i - 1] !== '--reason');
if (!id || (files.length === 0 && deletedFiles.length === 0)) {
  console.error('usage: reconcile-delta-provenance.mjs --id <delta-id> --reason "<why>" <file...> [--deleted <removed-file...>]');
  process.exit(2);
}

const deltaJson = JSON.parse(readFileSync(DELTA_FILE, 'utf8'));
const seedJson = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
const res = reconcile(deltaJson, seedJson, { id, reason, files, deletedFiles, sourceCommit: git(['rev-parse', 'HEAD']), nowIso: new Date().toISOString() });

for (const p of res.skipped) console.log(`  notice: ${p} is NOT delta-managed (new/unmanaged file) — skipped, no reconcile needed.`);
if (res.refusals?.length) {
  console.error('REFUSED — retirement not recorded:');
  for (const r of res.refusals) console.error(`  x ${r}`);
  process.exit(2);
}
if (!res.changed) { console.log('nothing to reconcile (all listed files are unmanaged).'); process.exit(0); }
writeFileSync(DELTA_FILE, JSON.stringify(deltaJson, null, 2) + '\n');
const retiredNote = res.exclusions.length ? `; ${res.exclusions.length} path(s) RETIRED` : '';
console.log(`reconciled delta '${id}': ${res.transformed.length} file(s)${retiredNote}; ${res.deltaCount} delta(s) total. Run: npm run verify:provenance`);
