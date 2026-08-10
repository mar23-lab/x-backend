#!/usr/bin/env node
// scripts/verify-domain-scaffold-honest-empty.mjs · ABS-P3 — the honest-empty guard for the
// customer-provisioning domain-skeleton scaffold.
//
// RULE: the archetype registry (src/workers/services/domain-archetypes.ts) is Tier-B STRUCTURE ONLY.
// A domain skeleton carries identity (slug/label/kind) + a structural binding + provenance metadata —
// and NOTHING that fabricates content: no goals, metrics, roadmaps, recommendations, counts, targets,
// review cadences, or timestamps baked into the seed data. A scaffolded domain must be structurally
// present but EMPTY; the customer (or a governed agent) fills it. This gate fails if a fabricated-content
// KEY appears as data in the archetype module. Comments (which legitimately say "NEVER carries goals…")
// are exempt — only executable/data lines are scanned.
//
// P-2 REMEDIATION (260729). Two defects:
//
//   1. THE SELF-TEST TESTED THIS FILE'S REGEXES, NOT THE GATE. Seven of eleven assertion callsites
//      were `expect('…', scanLine('<string literal defined right here>'))`. `scanLine` is defined in
//      this file; the strings were defined in this file. That proves a regex matches a string — it
//      says nothing about whether running this gate on a polluted archetype module produces a
//      non-zero exit. The self-test now writes MUTATED COPIES of the REAL archetype module into a
//      temp directory, SPAWNS this gate against each, and OBSERVES the exit code.
//   2. A MISSING TARGET EXITED 0. `if (!existsSync(target)) { console.log('☑ … absent — nothing to
//      scan'); process.exit(0); }` — a deleted, renamed or moved archetype module read as an honest
//      scaffold. That is the P-1 false-zero class inside a P-2 gate. Absence is now exit 2.
//
// EXIT CODES.  0 = honest-empty   1 = fabricated content found   2 = COULD NOT MEASURE
//
//   node scripts/verify-domain-scaffold-honest-empty.mjs
//   node scripts/verify-domain-scaffold-honest-empty.mjs --self-test      # OBSERVES a red
//   node scripts/verify-domain-scaffold-honest-empty.mjs --target=<path>  # aim it elsewhere

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_TARGET = 'src/workers/services/domain-archetypes.ts';
const argv = process.argv.slice(2);
const selfTest = argv.includes('--self-test');
const targetArg = argv.find((a) => a.startsWith('--target='));
const TARGET_PATH = targetArg ? path.resolve(targetArg.slice('--target='.length)) : path.join(repoRoot, DEFAULT_TARGET);
const TARGET_SHOWN = path.relative(repoRoot, TARGET_PATH) || TARGET_PATH;

// Forbidden fabricated-content KEYS (as object keys `key:`), never allowed in the archetype seed data.
// binding/metadata/slug/label/kind/visibility/owner_user_id/workspace_id/filters/values are all fine.
const FORBIDDEN = [
  { id: 'goal-content', label: 'goals / goal counts', pattern: /\b(goals|goal_count|goal_metric_contract)\s*:/ },
  { id: 'metric-content', label: 'metrics / targets', pattern: /\b(metrics|metric_name|target_value|target_delta|current_baseline|current_value)\s*:/ },
  { id: 'roadmap-content', label: 'roadmaps', pattern: /\b(roadmap|roadmap_id|roadmap_items|has_roadmap)\s*:/ },
  { id: 'recommendation-content', label: 'recommendations', pattern: /\b(recommendations|open_recommendation_count)\s*:/ },
  { id: 'review-content', label: 'review cadence data', pattern: /\b(review_due|review_cadence)\s*:/ },
  { id: 'fabricated-timestamp', label: 'baked-in timestamps', pattern: /\b(created_at|updated_at|occurred_at)\s*:/ },
];

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Returns the list of {id,label} blockers a line trips (empty = clean). Comments never trip. */
export function scanLine(line) {
  if (isCommentLine(line)) return [];
  return FORBIDDEN.filter((b) => b.pattern.test(line)).map((b) => ({ id: b.id, label: b.label }));
}

export function runChecks(src, shown = TARGET_SHOWN) {
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    for (const hit of scanLine(line)) {
      offenders.push(`${shown}:${i + 1}  [${hit.id}] ${line.trim().slice(0, 100)}`);
    }
  });
  return offenders;
}

// =================================================================================================
// SELF-TEST — the SUBJECT is this gate as a PROCESS; exit codes are OBSERVED from a child
// =================================================================================================
if (selfTest) {
  const rows = [];
  const problems = [];
  const record = (label, ok) => { rows.push('  ' + (ok ? 'PASS' : 'FAIL').padEnd(6) + '  ' + label); if (!ok) problems.push(label); };
  const run = (target) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--target=' + target], { encoding: 'utf8' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-scaffold-selftest-'));
  const realTarget = path.join(repoRoot, DEFAULT_TARGET);
  const donor = fs.existsSync(realTarget) ? fs.readFileSync(realTarget, 'utf8') : '';
  // Inject after the first line so the mutation lands in real module context, not in a bare file.
  const mutate = (name, injected) => {
    const p = path.join(tmp, name);
    const lines = donor.split('\n');
    lines.splice(Math.min(lines.length, 1), 0, injected);
    fs.writeFileSync(p, lines.join('\n'));
    return p;
  };

  // (1) CANNOT MEASURE — the archetype module missing must exit 2. Before this remediation it
  //     printed "absent — nothing to scan" and exited 0: a deleted subject read as a clean subject.
  const goneRun = run(path.join(tmp, 'no-such-module.ts'));
  record(`MISSING TARGET exits 2 "cannot measure" (observed exit=${goneRun.status})`, goneRun.status === 2);

  // (2) CANNOT MEASURE — an EMPTY INPUT SET. A zero-line module cannot be scanned for anything.
  const emptyTarget = path.join(tmp, 'empty-module.ts'); fs.writeFileSync(emptyTarget, '');
  const emptyRun = run(emptyTarget);
  record(`EMPTY TARGET exits 2 "cannot measure" (observed exit=${emptyRun.status})`, emptyRun.status === 2);

  // (3) CONTROL — the REAL archetype module, unmutated, must exit 0.
  const controlRun = run(realTarget);
  record(`CONTROL: the real archetype module exits 0 (observed exit=${controlRun.status})`, controlRun.status === 0);

  // (4)-(7) MUTANTS — one per forbidden CLASS, each proved to bite independently. A single mutant
  //         would let three dead patterns hide behind one live one.
  const mutants = [
    ['goal count', "  { slug: 'career', label: 'Career', kind: 'life', goal_count: 3 },", 'goal-content'],
    ['metrics/targets', "  metrics: [{ metric_name: 'ARR', target_value: 100000 }],", 'metric-content'],
    ['roadmap flag', '  has_roadmap: true,', 'roadmap-content'],
    ['baked-in timestamp', "  created_at: '2026-07-13',", 'fabricated-timestamp'],
  ];
  mutants.forEach(([name, injected, id], i) => {
    const p = mutate(`mutant-${i}.ts`, injected);
    const r = run(p);
    const out = (r.stdout || '') + (r.stderr || '');
    record(`MUTANT: ${name} injected into the real module drives exit 1 (observed exit=${r.status})`, r.status === 1);
    record(`MUTANT: the blocker id [${id}] is NAMED in the output`, out.includes(`[${id}]`));
  });

  // (8) CONTROL — a structural key must NOT bite, or the gate would fail the honest scaffold and
  //     be deleted rather than fixed.
  const structural = mutate('control-structural.ts', "  { slug: 'operations', label: 'Operations', kind: 'company' },");
  const structuralRun = run(structural);
  record(`CONTROL: a structural slug/label/kind row exits 0 (observed exit=${structuralRun.status})`, structuralRun.status === 0);

  // (9) CONTROL — a COMMENT naming the forbidden keys must NOT bite. This is the exemption the
  //     rule text promises; without a proof it is only a comment about a comment.
  const commented = mutate('control-comment.ts', '  // NEVER carries goals, metrics, roadmaps, or recommendations.');
  const commentedRun = run(commented);
  record(`CONTROL: a comment naming goals/metrics/roadmaps exits 0 (observed exit=${commentedRun.status})`, commentedRun.status === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n  SELF-TEST · verify-domain-scaffold-honest-empty (ABS-P3)');
  console.log('  ' + '-'.repeat(84));
  for (const r of rows) console.log(r);
  console.log('  ' + '-'.repeat(84));
  if (problems.length) {
    console.error(`  SELF-TEST FAIL — ${problems.length} case(s) wrong; this gate is a false-green.\n`);
    process.exit(1);
  }
  const passed = rows.length - problems.length;
  console.log(`  SELF-TEST PASS — ${passed}/${rows.length}, every case an OBSERVED exit code from a spawned run of this gate.\n`);
  process.exit(0);
}

// =================================================================================================
// THE GATE
// =================================================================================================
console.log('verify-domain-scaffold-honest-empty · ABS-P3');

// EXIT 2 — CANNOT MEASURE. An absent archetype module is not an honest scaffold; it is an unread
// subject. Reporting it as clean is the false-zero class this gate exists to prevent downstream.
if (!fs.existsSync(TARGET_PATH)) {
  console.error(`  ✗ CANNOT MEASURE — ${TARGET_SHOWN} does not exist.`);
  console.error('  A gate that inspected nothing has measured nothing; that is a false zero, not an honest-empty scaffold.');
  process.exit(2);
}

const src = fs.readFileSync(TARGET_PATH, 'utf8');
const scannedLines = src.split('\n').filter((l) => l.trim().length);

// EXIT 2 — EMPTY INPUT SET. `scannedLines` is the denominator of the claim below.
if (!scannedLines.length) {
  console.error(`  ✗ CANNOT MEASURE — ${TARGET_SHOWN} exists but holds ZERO non-blank lines.`);
  console.error('  A gate that inspected nothing has measured nothing; that is a false zero, not a pass.');
  process.exit(2);
}

const offenders = runChecks(src);
if (offenders.length > 0) {
  console.error(`\n✗ ${offenders.length} fabricated-content key(s) in the archetype registry — skeletons must be STRUCTURE ONLY (slug/label/kind):`);
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`  ☑ archetype domain skeletons are honest-empty across ${scannedLines.length} scanned line(s) in ${TARGET_SHOWN}`);
console.log('    (no goals/metrics/roadmaps/recommendations/review-cadence/timestamps baked in)');
console.log('\n☑ domain-scaffold-honest-empty holds');
process.exit(0);
