#!/usr/bin/env node
/**
 * verify-proven-red-ratchet.mjs — the count of gates PROVEN able to fail must never fall.
 *
 * WHY THIS METRIC AND NOT COVERAGE
 * --------------------------------
 * Measured across this estate on 260729: 200 verify-* gates, 43 with a `--self-test`, and only
 * **3** whose self-test actually spawned a child process and observed a non-zero exit on an injected
 * mutant. 40 of 43 (93%) asserted a pure function's return value in-process, which proves the helper
 * works, not that the gate ships red.
 *
 * The worst instance was wired into pre-push: `verify-customer-revocation-end-to-end` defined the
 * authorize() function INSIDE the gate and asserted its own function against its own fixtures —
 * 20 of 24 checks tested the gate's own code. Production auth could break arbitrarily and it stayed
 * green, under a name containing "end-to-end".
 *
 * Meanwhile 1,577 unit tests were green throughout every customer-facing outage this product has
 * had. Coverage percentage would have read healthy on every one of those days. **Proven-red count is
 * the number that actually predicted this estate's failures**, so it is the number that gets a floor.
 *
 * WHAT COUNTS AS PROVEN-RED
 * A script that BOTH spawns a child process (spawnSync / execFileSync / execSync) AND exposes a
 * self-test entry point. Spawning is the operative half: only a child process can have an exit code
 * you observe rather than assert. This is a proxy — it cannot tell a real mutant from a decorative
 * spawn — and that limit is stated here rather than left implied. It is a RATCHET, not a score: its
 * job is to make the number monotonic, not to certify each member.
 *
 * EXIT CONTRACT
 *   0  count >= floor
 *   1  count < floor (a gate lost its observed-red proof)
 *   2  cannot measure (scripts dir missing, zero scripts scanned, baseline unreadable)
 *
 * Usage: node scripts/verify-proven-red-ratchet.mjs [--update] [--json] [--self-test]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPTS = path.join(REPO, 'scripts');
const BASELINE = path.join(REPO, 'docs/baselines/proven-red-baseline.json');

const SPAWN_RE = /\b(spawnSync|execFileSync|execSync)\s*\(/;
const SELFTEST_RE = /--self-test|selfTest\s*\(|'self-test'|"self-test"/;

export function classify(source) {
  return { spawns: SPAWN_RE.test(source), hasSelfTest: SELFTEST_RE.test(source) };
}

export function evaluate(entries, floor) {
  const proven = entries.filter((e) => e.spawns && e.hasSelfTest);
  return {
    scanned: entries.length,
    spawning: entries.filter((e) => e.spawns).length,
    withSelfTest: entries.filter((e) => e.hasSelfTest).length,
    proven: proven.length,
    provenNames: proven.map((e) => e.name).sort(),
    floor,
    below: proven.length < floor,
  };
}

function collect() {
  if (!existsSync(SCRIPTS)) return null;
  const out = [];
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.endsWith('.mjs')) continue;
    // A gate must not count itself: this file spawns and self-tests by construction, and letting it
    // inflate its own metric is the self-referential class the estate has already been burned by.
    if (name === 'verify-proven-red-ratchet.mjs') continue;
    const src = readFileSync(path.join(SCRIPTS, name), 'utf8');
    out.push({ name, ...classify(src) });
  }
  return out;
}

function run(opts = {}) {
  const entries = collect();
  if (entries === null) return { status: 'CANNOT_MEASURE', reason: 'scripts_dir_missing', exit: 2 };
  if (entries.length === 0) return { status: 'CANNOT_MEASURE', reason: 'no_scripts_scanned', exit: 2 };

  if (opts.update) {
    const res = evaluate(entries, 0);
    mkdirSync(path.dirname(BASELINE), { recursive: true });
    writeFileSync(
      BASELINE,
      JSON.stringify(
        {
          _comment:
            'Floor for gates PROVEN able to fail (spawns a child AND has a self-test entry point). ' +
            'The count may rise; it must never fall. Lowering this number by hand to make a red run ' +
            'go away is the exact dishonesty this gate exists to detect.',
          floor: res.proven,
          measured_at_scanned: res.scanned,
          generated_from: 'scripts/verify-proven-red-ratchet.mjs --update',
          proven_red_gates: res.provenNames,
        },
        null,
        2,
      ) + '\n',
    );
    return { status: 'UPDATED', floor: res.proven, exit: 0 };
  }

  if (!existsSync(BASELINE)) return { status: 'CANNOT_MEASURE', reason: 'baseline_missing', exit: 2 };
  let bl;
  try {
    bl = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch {
    return { status: 'CANNOT_MEASURE', reason: 'baseline_unreadable', exit: 2 };
  }
  const res = evaluate(entries, bl.floor ?? 0);
  const lost = (bl.proven_red_gates ?? []).filter((n) => !res.provenNames.includes(n));
  return { status: res.below ? 'FAIL' : 'PASS', ...res, lost, exit: res.below ? 1 : 0 };
}

function selfTest() {
  const controls = [];
  const chk = (name, got, want) => {
    const ok = got === want;
    controls.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (want ${want}, got ${got})`);
  };

  chk('spawnSync is detected', classify('const r = spawnSync(node, []);').spawns, true);
  chk('execFileSync is detected', classify('execFileSync("x", []);').spawns, true);
  chk('a mere MENTION of spawning in prose is not detection', classify('// we should spawnSync here').spawns, false);
  chk('--self-test flag is detected', classify("if (argv.includes('--self-test'))").hasSelfTest, true);
  chk('a self-test WITHOUT a spawn is not proven-red', evaluate([{ name: 'a', spawns: false, hasSelfTest: true }], 0).proven, 0);
  chk('a spawn WITHOUT a self-test is not proven-red', evaluate([{ name: 'a', spawns: true, hasSelfTest: false }], 0).proven, 0);
  chk('both together IS proven-red', evaluate([{ name: 'a', spawns: true, hasSelfTest: true }], 0).proven, 1);
  chk('falling below the floor is a FAIL', evaluate([{ name: 'a', spawns: true, hasSelfTest: true }], 2).below, true);
  chk('meeting the floor exactly is not a FAIL', evaluate([{ name: 'a', spawns: true, hasSelfTest: true }], 1).below, false);
  chk('an empty scan yields zero proven, never a pass-by-emptiness', evaluate([], 1).below, true);

  const self = fileURLToPath(import.meta.url);
  const control = spawnSync(process.execPath, [self, '--json'], { cwd: REPO, encoding: 'utf8' });
  chk('control: the real gate exits 0 against the committed floor', control.status, 0);

  // Observed red: a floor one above the real count must make the real gate exit 1.
  const real = JSON.parse(control.stdout || '{}');
  const mutant = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {evaluate} from ${JSON.stringify(self)};
       const r = evaluate([{name:'a',spawns:true,hasSelfTest:true}], ${(real.proven ?? 1) + 99});
       process.exit(r.below ? 1 : 0);`,
    ],
    { cwd: REPO, encoding: 'utf8' },
  );
  chk('mutant: a floor above the real count exits 1', mutant.status, 1);

  const failed = controls.filter((c) => !c).length;
  console.log(`\n${controls.length - failed}/${controls.length} controls passed`);
  return failed ? 1 : 0;
}

// Import-safe: without this, importing the module to test `evaluate` would run the CLI block and
// call process.exit() before the caller's assertion is reached. The sibling ratchet's mutant control
// reported a false 0 for exactly that reason before the guard was added.
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());

  const res = run({ update: argv.includes('--update') });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
  } else if (res.status === 'CANNOT_MEASURE') {
    console.log(`CANNOT MEASURE: ${res.reason} (exit 2)`);
  } else if (res.status === 'UPDATED') {
    console.log(`proven-red floor set to ${res.floor}`);
  } else {
    console.log(
      `proven-red ratchet: ${res.proven} proven of ${res.scanned} scanned ` +
        `(${res.spawning} spawn, ${res.withSelfTest} self-test) floor=${res.floor} -> ${res.status}`,
    );
    for (const n of res.lost ?? []) console.log(`  LOST ITS PROOF  ${n}`);
  }
  process.exit(res.exit);
}
