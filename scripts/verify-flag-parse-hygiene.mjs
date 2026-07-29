#!/usr/bin/env node
// scripts/verify-flag-parse-hygiene.mjs · J-W0 (260711-I / FGH-1/2) — the structural fix for the
// quote-intolerant flag-parse class.
//
// ROOT CAUSE (Part O.4 readiness-gate failure, re-surfaced by the J-wave audit as FGH-1): a flag
// read as `String(env.X_ENABLED || '') === 'true'` (or `!== 'true'`, or `.toLowerCase() === 'true'`)
// silently fails to engage when the value is entered via the Cloudflare dashboard / `wrangler secret
// put` as the quoted string `"true"` — the exact entry path for an un-declared flag. For a
// security-relevant flag whose OFF direction is the LESS-safe one (e.g. SOURCE_SCOPE_ENFORCEMENT),
// that is a fail-toward-less-safe defect. `src/workers/lib/env-flag.ts::envFlagTrue` strips quotes +
// whitespace and lower-cases before comparing; it is the ONLY sanctioned flag reader.
//
// THE RULE: no `*_ENABLED` env flag may be compared with a bare `=== 'true'` / `!== 'true'` /
// `.toLowerCase() === 'true'`. Route every flag read through envFlagTrue(...). env-flag.ts itself and
// test files are exempt (the reader's own definition + tests that assert the tolerant behavior).
//
// P-2 REMEDIATION (260729). Two defects:
//
//   1. THE SELF-TEST TESTED THIS FILE'S REGEX, NOT THE GATE. Five of nine assertion callsites were
//      `expect('…', scanLine('<string literal defined right here>'))`. `scanLine` and the strings are
//      both defined in this file, so the test proved a regex matches a string. It proved nothing
//      about whether a real offending line in a real `src/workers` tree drives a non-zero exit. The
//      self-test now seeds .ts files into a temp tree, SPAWNS this gate at it, and OBSERVES the exit.
//   2. AN EMPTY SCAN TREE READ AS CLEAN. `tsFiles()` returning zero files left `offenders` empty and
//      the gate printed "all *_ENABLED flag reads route through envFlagTrue" — a false zero on a
//      moved or mis-resolved src/workers. The denominator is now asserted and printed.
//
// EXIT CODES.  0 = measured clean   1 = quote-intolerant read(s) found   2 = COULD NOT MEASURE
//
//   node scripts/verify-flag-parse-hygiene.mjs
//   node scripts/verify-flag-parse-hygiene.mjs --self-test         # OBSERVES a red
//   node scripts/verify-flag-parse-hygiene.mjs --scan-root=<dir>   # aim it elsewhere

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_SCAN_ROOT = 'src/workers';
const READER = 'src/workers/lib/env-flag.ts';
const argv = process.argv.slice(2);
const selfTest = argv.includes('--self-test');
const scanArg = argv.find((a) => a.startsWith('--scan-root='));
const SCAN_ROOT = scanArg ? path.resolve(scanArg.slice('--scan-root='.length)) : path.join(repoRoot, DEFAULT_SCAN_ROOT);

// A line offends if it reads a *_ENABLED flag with a strict/lowercase comparison to 'true'.
// Comments are allowed to describe the historical form; we only flag executable code, so lines whose
// first non-space chars are `//` or `*` are skipped.
const OFFENDER = /_ENABLED\b[\s\S]*?(===|!==)\s*'true'|_ENABLED\b[\s\S]*?\.toLowerCase\(\)\s*===\s*'true'/;

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function tsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export function scanLine(line) {
  if (isCommentLine(line)) return false;
  return OFFENDER.test(line);
}

export function runChecks(files) {
  const offenders = [];
  for (const abs of files) {
    const shown = path.relative(repoRoot, abs);
    if (shown === READER || shown.includes('__tests__')) continue;
    fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      if (scanLine(line)) offenders.push(`${shown}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  return offenders;
}

// =================================================================================================
// SELF-TEST — the SUBJECT is this gate as a PROCESS; exit codes are OBSERVED from a child
// =================================================================================================
if (selfTest) {
  const rows = [];
  const problems = [];
  const record = (label, ok) => { rows.push('  ' + (ok ? 'PASS' : 'FAIL').padEnd(6) + '  ' + label); if (!ok) problems.push(label); };
  const run = (root) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scan-root=' + root], { encoding: 'utf8' });
  const seedTree = (name, body) => {
    const root = path.join(tmp, name);
    fs.mkdirSync(path.join(root, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'routes', 'flags.ts'), body);
    return root;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-flagparse-selftest-'));

  // (1) CANNOT MEASURE — a scan root that does not exist must exit 2, never 0.
  const goneRun = run(path.join(tmp, 'no-such-root'));
  record(`MISSING SCAN ROOT exits 2 "cannot measure" (observed exit=${goneRun.status})`, goneRun.status === 2);

  // (2) CANNOT MEASURE — a scan root holding zero .ts files must exit 2. This is the false zero the
  //     remediation closes: before it, an empty tree printed the hygiene claim.
  const emptyRoot = path.join(tmp, 'empty'); fs.mkdirSync(emptyRoot, { recursive: true });
  const emptyRun = run(emptyRoot);
  record(`EMPTY INPUT SET exits 2 "cannot measure" (observed exit=${emptyRun.status})`, emptyRun.status === 2);

  // (3) CONTROL — the REAL src/workers tree must be MEASURABLE: a verdict (0 or 1), never 2.
  //     HISTORY, stated rather than hidden: until 260729 the real tree exited 1 on two
  //     quote-intolerant reads — src/workers/crons/tenant-projection-dispatch.ts:8 and
  //     src/workers/index.ts:447. The ORIGINAL gate at the production checkout
  //     (e40bf927fe90d8b557858c86ac30eb5256a3d7ba) exited 1 on them too, so that red was never a
  //     regression introduced by the rewrite — it was a latent defect nothing was watching,
  //     because this gate was referenced by no npm script. Both reads now route through
  //     envFlagTrue, and the gate runs in ci-local as verify:flag-parse-hygiene, which is what
  //     makes a future red visible. This case still accepts 0 OR 1 deliberately: it asserts
  //     MEASURABILITY, not a verdict — the clean-tree proof is case (7).
  const controlRun = run(path.join(repoRoot, DEFAULT_SCAN_ROOT));
  record(`CONTROL: the real src/workers tree is MEASURABLE, verdict not "cannot measure" (observed exit=${controlRun.status})`,
    controlRun.status === 0 || controlRun.status === 1);

  // (4)-(6) MUTANTS — each offending FORM must bite on its own, in a real file, through a real run.
  const forms = [
    ['strict ===', "export const on = String(ctx.env.FOO_ENABLED || '') === 'true';\n"],
    ['strict !==', "export function guard(env) { if (env.BAR_ENABLED !== 'true') return null; return 1; }\n"],
    ['lowercase ===', "export const on = String(env.BAZ_ENABLED || '').toLowerCase() === 'true';\n"],
  ];
  forms.forEach(([name, body], i) => {
    const r = run(seedTree(`mutant-${i}`, body));
    const out = (r.stdout || '') + (r.stderr || '');
    record(`MUTANT: ${name} comparison drives exit 1 (observed exit=${r.status})`, r.status === 1);
    record(`MUTANT: the offending file and line are NAMED (${name})`, /routes\/flags\.ts:1/.test(out));
  });

  // (7) CONTROL — the sanctioned reader must NOT bite, or "route through envFlagTrue" is unfollowable.
  const tolerantRun = run(seedTree('control-tolerant', 'export const on = envFlagTrue(ctx.env.FOO_ENABLED);\n'));
  record(`CONTROL: envFlagTrue(...) exits 0 (observed exit=${tolerantRun.status})`, tolerantRun.status === 0);

  // (8) CONTROL — a COMMENT describing the historical form must NOT bite. This is the exemption the
  //     rule text promises; without a proof it is only a claim.
  const commentRun = run(seedTree('control-comment', "// true only when FOO_ENABLED === 'true' (route-read)\nexport const on = envFlagTrue(ctx.env.FOO_ENABLED);\n"));
  record(`CONTROL: a comment describing the old form exits 0 (observed exit=${commentRun.status})`, commentRun.status === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n  SELF-TEST · verify-flag-parse-hygiene (J-W0 · FGH-1/2)');
  console.log('  ' + '-'.repeat(84));
  for (const r of rows) console.log(r);
  console.log('  ' + '-'.repeat(84));
  if (problems.length) {
    console.error(`  SELF-TEST FAIL — ${problems.length} case(s) wrong; this gate is a false-green.\n`);
    process.exit(1);
  }
  console.log(`  SELF-TEST PASS — ${rows.length}/${rows.length}, every case an OBSERVED exit code from a spawned run of this gate.\n`);
  process.exit(0);
}

// =================================================================================================
// THE GATE
// =================================================================================================
console.log('verify-flag-parse-hygiene · J-W0 (FGH-1/2)');

if (!fs.existsSync(SCAN_ROOT)) {
  console.error(`  ✗ CANNOT MEASURE — scan root missing: ${SCAN_ROOT}`);
  console.error('  A vanished root must not silently shrink the subject. Re-point this gate, then re-run.');
  process.exit(2);
}

const files = tsFiles(SCAN_ROOT);

// EXIT 2 — EMPTY INPUT SET. `files` is the denominator of the hygiene claim below.
if (!files.length) {
  console.error(`  ✗ CANNOT MEASURE — ${SCAN_ROOT} exists but holds ZERO .ts files.`);
  console.error('  A gate that inspected nothing has measured nothing; that is a false zero, not hygiene.');
  process.exit(2);
}

const offenders = runChecks(files);
if (offenders.length > 0) {
  console.error(`\n✗ ${offenders.length} flag read(s) use a quote-intolerant strict/lowercase comparison — route through envFlagTrue (${READER}):`);
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`  ☑ ${files.length} .ts file(s) scanned; all *_ENABLED flag reads route through envFlagTrue (quote-tolerant)`);
console.log('\n☑ flag-parse-hygiene holds');
process.exit(0);
