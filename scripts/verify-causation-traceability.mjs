#!/usr/bin/env node
// scripts/verify-causation-traceability.mjs
//
// ADR-XLOOP-ARCH-003 VII · HR-CAUSATION-TRACEABILITY-1 teeth. Causation is the connective tissue: every
// effect node must resolve to a cause, the RCA backward walk must TERMINATE at a root, and it must be
// ACYCLIC. Asserts (static + runtime):
//   (1) data-graph.ts exports the causation primitives (traceCause, effectNodesRequiringCause,
//       CAUSE_EDGE_TYPES) + the PROV-aligned edges (caused_by, feeds) + the `source` lineage-origin node.
//   (2) buildDataGraph EMITS caused_by (the edge is produced, not just typed — the C2 overstated-claim
//       lesson: no "enforced" without a wired producer) and GUARDS it (no fabricated/dangling edge).
//   (3) traceCause has real cycle detection (a back-edge sets cyclic) — the RCA-terminates invariant.
//   (4) the test suite proves the gate BITES: a should-PASS (terminated) AND a should-FAIL (cyclic +
//       orphan-drop) fixture both asserted.
//   (5) the runtime proof: the causation vitest suite is GREEN.
//
// `--self-test` proves THIS verifier bites: predicate (3) must FAIL on a cycle-guard-stripped variant and
// PASS on the real module (the should-FAIL/should-PASS pair the keystone verify_self_tests_bite.py wants).
//
// Exit 0 = causation/RCA invariants hold. Exit 1 = violated.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const P = (...a) => path.join(repoRoot, ...a);
const read = (rel) => { try { return fs.readFileSync(P(rel), 'utf8'); } catch { return null; } };

const MODULE = 'src/workers/graph/data-graph.ts';
const TEST = 'src/workers/__tests__/data-graph.test.ts';

// ── the predicate under self-test: does the module have REAL cycle detection? ──
// A back-edge on the active DFS path must set `cyclic`. We look for the onPath/visiting guard that
// assigns cyclic = true. A rubber-stamp (no such guard) would let an infinite causal loop pass RCA.
function hasCycleDetection(src) {
  if (!src) return false;
  // a guard of the form: if (<onPath set>.has(id)) { cyclic = true; ... }
  return /\.has\(\s*id\s*\)\s*\)\s*\{\s*cyclic\s*=\s*true/.test(src) || /cyclic\s*=\s*true/.test(src) && /onPath|visiting/.test(src);
}

if (process.argv.includes('--self-test')) {
  const real = read(MODULE);
  // should-PASS: the real module has cycle detection.
  const passReal = hasCycleDetection(real);
  // should-FAIL: strip the cycle-guard → the predicate must now report NO detection.
  const stripped = String(real || '').replace(/cyclic\s*=\s*true/g, '/* stripped */ void 0');
  const failStripped = hasCycleDetection(stripped) === false;
  if (passReal && failStripped) {
    console.log('☑ self-test: cycle-detection predicate BITES (passes the real module, fails a cycle-guard-stripped variant)');
    process.exit(0);
  }
  console.error(`✗ self-test: predicate did not bite (passReal=${passReal}, failStripped=${failStripped})`);
  process.exit(1);
}

const fails = [];
const notes = [];
const ok = (label, pass, detail) => { (pass ? notes : fails).push(`  ${pass ? '☑' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`); };

const src = read(MODULE);
if (!src) {
  ok('the data-graph module exists', false, `${MODULE} missing`);
} else {
  // (1) exports the causation primitives + the PROV-aligned edges + the source node
  for (const sym of ['traceCause', 'effectNodesRequiringCause', 'CAUSE_EDGE_TYPES']) {
    ok(`(1) exports ${sym}`, new RegExp(`export\\s+(?:function|const)\\s+${sym}\\b`).test(src), null);
  }
  ok("(1) GraphEdgeType includes 'caused_by' + 'feeds'", /'caused_by'/.test(src) && /'feeds'/.test(src), null);
  ok("(1) GraphNodeType includes 'source' (lineage origin)", /'source'/.test(src) && /GraphNodeType\s*=/.test(src), null);
  // (2) buildDataGraph EMITS caused_by + GUARDS it (both endpoints must be real nodes)
  ok('(2) buildDataGraph emits caused_by from the causation map', /addEdge\([^,]+,[^,]+,\s*'caused_by'\)/.test(src), null);
  ok('(2) caused_by is GUARDED (both endpoints must exist — no dangling/fabricated edge)',
    /seenNode\.has\(c\.effect\)\s*&&\s*seenNode\.has\(c\.cause\)/.test(src), null);
  ok('(2) buildDataGraph emits the feeds edge (source → project)', /addEdge\([^,]+,[^,]+,\s*'feeds'\)/.test(src), null);
  // (3) REAL cycle detection (the RCA-terminates invariant)
  ok('(3) traceCause has real cycle detection (back-edge sets cyclic)', hasCycleDetection(src), null);
  ok('(3) traceCause reports roots + terminated (RCA termination)', /roots/.test(src) && /terminated/.test(src), null);
}

// (4) the test suite proves the gate BITES — a should-PASS + a should-FAIL fixture
const test = read(TEST);
if (!test) {
  ok('(4) the causation test exists', false, `${TEST} missing`);
} else {
  ok('(4) should-PASS: a terminated RCA walk is asserted', /terminated\)\.toBe\(true\)/.test(test), null);
  ok('(4) should-FAIL: a cyclic chain is detected (cyclic=true)', /cyclic\)\.toBe\(true\)/.test(test), null);
  ok('(4) should-FAIL: a dangling causation pair is DROPPED (no fabricated edge)',
    /caused_by[\s\S]{0,200}toBe\(false\)/.test(test) || /DOES-NOT-EXIST/.test(test), null);
}

// (5) runtime proof — the causation vitest suite is green
try {
  execSync(`npx vitest run ${TEST} src/workers/__tests__/persist-data-graph.test.ts --reporter dot`, { cwd: repoRoot, stdio: 'pipe', timeout: 120000 });
  ok('(5) causation + persist vitest suite passes (RCA logic proven at runtime)', true, 'vitest green');
} catch (e) {
  const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
  ok('(5) causation + persist vitest suite passes', false, `vitest FAILED: ${out.split('\n').filter((l) => /✗|FAIL|Error/.test(l)).slice(0, 2).join(' | ').slice(0, 200)}`);
}

console.log('ADR-XLOOP-ARCH-003 VII · causation/RCA traceability (HR-CAUSATION-TRACEABILITY-1)');
console.log('─'.repeat(66));
console.log(notes.join('\n'));
if (fails.length) {
  console.error('─'.repeat(66));
  console.error(`✗ causation/RCA invariant BROKEN · ${fails.length} violation(s):`);
  console.error(fails.join('\n'));
  process.exit(1);
}
console.log('─'.repeat(66));
console.log('☑ causation is first-class: caused_by emitted + guarded · RCA terminates + acyclic · gate bites');
process.exit(0);
