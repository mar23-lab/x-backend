#!/usr/bin/env node
// verify-controls-measure-something.mjs — the meta-gate.
//
// SIX controls in this estate have now been found reporting success while evaluating nothing:
//
//   1. verify:coverage-claim        ZERO lines matched its CLAIM regex; printed PASS while BLOCKING.
//                                   RETIRED for it (x-ai-front/CLAUDE.md:31-36).
//   2. ci-local.mjs                 printed `${gates.length}/${gates.length}` — a template over the
//                                   SAME constant on both sides, structurally unable to say anything
//                                   but N/N.
//   3. verify-wired-freeze.mjs      printed the literal string '0 additions' while its tuple count
//                                   moved 40 -> 42 behind exemptions.
//   4. rls-shadow-soak.mjs          printed SKIP and process.exit(0) — green with 0 assertions, on
//                                   every machine without the two URLs bound (i.e. all but one).
//   5. verify-postgres-rls-phase2   downgraded the missing app-role URL to a WARNING.
//   6. app/control-ledger           carried a contract_hash compared to nothing for 10 days.
//
// Each was found by a human reading the code. That does not scale, and the shapes are mechanical.
// This gate detects the two shapes with hard evidence behind them. It is deliberately NARROW:
// a meta-gate that cries wolf gets muted, which would make it the seventh entry on that list.
//
// SHAPE A · self-referential ratio. A template literal of the form ${x}/${x} where both sides are
//   the same expression. Such a line cannot disagree with itself, so it is not evidence.
//
// SHAPE B · skip-then-succeed. An explicit exit(0) within a few lines of a SKIP log, with no
//   accompanying statement that zero assertions ran. A skip is legitimate; a skip that READS as a
//   pass is not. Saying so is the remedy, so saying so is the exemption.
//
//   node scripts/verify-controls-measure-something.mjs
//   node scripts/verify-controls-measure-something.mjs --self-test   # proves it can go RED

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE);
const selfTest = process.argv.includes('--self-test');

const SELF = 'verify-controls-measure-something.mjs'; // documents the shapes; never flag itself

/**
 * Strip comments before scanning. Without this the gate flags the very comments that DOCUMENT a
 * fixed defect — it fired on ci-local.mjs's explanation of the ratio bug it no longer has. Reporting
 * a fix as a finding is how a meta-gate earns its own mute, so the exclusion is load-bearing.
 * Comment-aware, not string-aware: a slash inside a string literal is not a comment start here,
 * which is acceptable because both shapes are code-shaped, not string-shaped.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')) // line comments, sparing :// in URLs
    .join('\n');
}

/** SHAPE A — `${expr}/${expr}` with an identical expression on both sides. */
export function findSelfReferentialRatio(source) {
  const hits = [];
  const re = /\$\{([^}]{1,60})\}\s*\/\s*\$\{([^}]{1,60})\}/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (m[1].trim() === m[2].trim()) hits.push(m[1].trim());
  }
  return hits;
}

/** SHAPE B — an exit(0) shortly after a SKIP log that never states the assertion count. */
export function findSkipThenSucceed(source) {
  const lines = source.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    // Status markers are deliberately uppercase. Case-insensitive substring matching classified
    // ordinary prose such as "only non-production skips" and "cannot be skipped" as skip results.
    if (!/\bSKIP(?:PED)?\b/.test(lines[i])) continue;
    if (!/console\.(log|warn|error)/.test(lines[i])) continue;
    const window = lines.slice(i, Math.min(i + 6, lines.length)).join('\n');
    if (!/exit\(\s*0\s*\)/.test(window)) continue;
    if (/0 assertion|zero assertion|NOT a pass|not a pass/i.test(window)) continue;
    hits.push(i + 1);
  }
  return hits;
}

function runSelfTest() {
  const ratioBad = 'console.log(`PASS (${gates.length}/${gates.length})`)';
  const ratioOk = 'console.log(`PASS (${passed}/${gates.length})`)';
  const skipBad = "console.log('thing SKIP - set URLS to run.');\nprocess.exit(0);";
  const skipOk = "console.log('thing SKIPPED (0 assertions evaluated) - this is NOT a pass.');\nprocess.exit(0);";
  const ordinarySkips = "console.log('only explicit non-production skips');\nprocess.exit(0);";
  const cannotBeSkipped = "console.error('proof cannot be skipped under production authority');\nprocess.exit(0);";
  const controls = [
    [findSelfReferentialRatio(ratioBad).length > 0, true, 'detects the self-referential ratio'],
    [findSelfReferentialRatio(ratioOk).length > 0, false, 'allows a real measured ratio'],
    [findSkipThenSucceed(skipBad).length > 0, true, 'detects skip-then-exit(0)'],
    [findSkipThenSucceed(skipOk).length > 0, false, 'allows a skip that states 0 assertions'],
    [findSkipThenSucceed(ordinarySkips).length > 0, false, 'ignores the ordinary word skips'],
    [findSkipThenSucceed(cannotBeSkipped).length > 0, false, 'ignores ordinary lowercase skipped prose'],
  ];
  const failed = controls.filter(([actual, expected]) => actual !== expected);
  if (failed.length > 0) {
    console.error(`verify-controls-measure-something self-test FAIL: ${failed.map((r) => r[2]).join(', ')}`);
    process.exit(1);
  }
  console.log('verify-controls-measure-something self-test PASS · 2 positive + 4 negative controls');
}

function main() {
  if (selfTest) return runSelfTest();

  const all = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));
  const findings = [];
  for (const entry of all) {
    if (entry === SELF) continue;
    const source = stripComments(readFileSync(join(SCRIPTS, entry), 'utf8'));
    for (const expr of findSelfReferentialRatio(source)) {
      findings.push(`${entry} · self-referential ratio over "${expr}" — cannot disagree with itself`);
    }
    for (const line of findSkipThenSucceed(source)) {
      findings.push(`${entry}:${line} · SKIP followed by exit(0) without stating that 0 assertions ran`);
    }
  }

  if (findings.length === 0) {
    console.log(`verify-controls-measure-something · PASS · ${all.length} scripts scanned, 0 hollow-success shapes`);
    return;
  }
  console.error('verify-controls-measure-something · FINDINGS — controls that may report success while measuring nothing:');
  for (const f of findings) console.error(`  - ${f}`);
  console.error('  A control cited as assurance that measures nothing is worse than no control.');
  process.exit(1);
}

main();
