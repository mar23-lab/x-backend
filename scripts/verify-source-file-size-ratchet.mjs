#!/usr/bin/env node
/**
 * verify-source-file-size-ratchet.mjs — no NEW oversized source file.
 *
 * WHY A RATCHET AND NOT A LIMIT
 * -----------------------------
 * The 500-LOC guideline was measured against the donor before this gate was written:
 *
 *   x-ai-front app/ (FSD rebuild)   0 of 55 files over 500     <- the only codebase that meets it
 *   Xlooop-XCP-demo (donor)        19 of 838 (2.3%)
 *   x-backend                      20 of 255 (7.8%)
 *
 * and the donor's own AGENTS.md codifies NO such rule. So the bar is an aspiration, not a standard
 * we fell behind on. Sharper still: x-backend's two worst files are the donor's two worst files,
 * inherited and grown — workspaces.ts 1719 -> 2003, WorkersDalAdapter 1648 -> 1701.
 *
 * Mass-refactoring production route files to satisfy a number invites regressions with no
 * behavioural gain. A ratchet costs nothing and stops the bleeding: the existing 20 are baselined by
 * PATH, and any NEW file crossing the line fails. A baselined file that GROWS is allowed (it is
 * already over; policing its slope is a different, noisier gate), but a baselined file that drops
 * under 500 is removed on --update, so the ratchet only ever tightens instead of decaying into a
 * permanent allowlist.
 *
 * EXIT CONTRACT
 *   0  no new oversized file
 *   1  a new file crossed the threshold
 *   2  cannot measure (source root missing, no files found, baseline unreadable)
 *
 * Exit 2 exists because a gate that silently finds zero files is indistinguishable from a gate that
 * finds no problems — the false-zero class this repo has measured repeatedly.
 *
 * Usage: node scripts/verify-source-file-size-ratchet.mjs [--update] [--json] [--self-test]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const LIMIT = 500;
const BASELINE = path.join(REPO, 'docs/baselines/source-file-size-baseline.json');

/** Walk .ts under src/, excluding tests — tests are allowed to be long; fixtures dominate them. */
function collect(root) {
  const out = [];
  if (!existsSync(root)) return null; // cannot measure
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(p);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
        out.push({ path: path.relative(REPO, p), lines: readFileSync(p, 'utf8').split('\n').length });
      }
    }
  };
  walk(root);
  return out;
}

function loadBaseline() {
  if (!existsSync(BASELINE)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch {
    return null;
  }
}

export function evaluate(files, baselinePaths, limit = LIMIT) {
  const over = files.filter((f) => f.lines > limit);
  const overPaths = new Set(over.map((f) => f.path));
  const baseline = new Set(baselinePaths);
  const regressions = over.filter((f) => !baseline.has(f.path));
  const graduated = [...baseline].filter((p) => !overPaths.has(p));
  return { total: files.length, over: over.length, regressions, graduated };
}

function run(opts = {}) {
  const files = collect(path.join(REPO, 'src'));
  if (files === null) return { status: 'CANNOT_MEASURE', reason: 'src_root_missing', exit: 2 };
  if (files.length === 0) return { status: 'CANNOT_MEASURE', reason: 'no_source_files_found', exit: 2 };

  if (opts.update) {
    const over = files.filter((f) => f.lines > LIMIT).map((f) => f.path).sort();
    mkdirSync(path.dirname(BASELINE), { recursive: true });
    writeFileSync(
      BASELINE,
      JSON.stringify(
        {
          _comment:
            'Files already over the 500-line guideline when the ratchet landed. NEW entries are a ' +
            'regression and fail the gate. Entries that drop under the limit are removed on --update ' +
            'so the ratchet only tightens. Do not hand-add paths to silence a failure.',
          limit: LIMIT,
          generated_from: 'scripts/verify-source-file-size-ratchet.mjs --update',
          over_limit: over,
        },
        null,
        2,
      ) + '\n',
    );
    return { status: 'UPDATED', count: over.length, exit: 0 };
  }

  const bl = loadBaseline();
  if (bl === null) return { status: 'CANNOT_MEASURE', reason: 'baseline_missing_or_unreadable', exit: 2 };
  const res = evaluate(files, bl.over_limit ?? [], LIMIT);
  return { status: res.regressions.length ? 'FAIL' : 'PASS', ...res, exit: res.regressions.length ? 1 : 0 };
}

/** Observed-red self-test: the gate runs as a CHILD and its exit code is read, never asserted. */
function selfTest() {
  const controls = [];
  const chk = (name, got, want) => {
    const ok = got === want;
    controls.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (want ${want}, got ${got})`);
  };

  const files = [
    { path: 'src/a.ts', lines: 900 },
    { path: 'src/b.ts', lines: 100 },
    { path: 'src/c.ts', lines: 700 },
  ];
  chk('a baselined oversized file is NOT a regression', evaluate(files, ['src/a.ts', 'src/c.ts']).regressions.length, 0);
  chk('an UNBASELINED oversized file IS a regression', evaluate(files, ['src/a.ts']).regressions.length, 1);
  chk('the regression names the right file', evaluate(files, ['src/a.ts']).regressions[0].path, 'src/c.ts');
  chk('a file that dropped under the limit GRADUATES', evaluate(files, ['src/a.ts', 'src/c.ts', 'src/b.ts']).graduated.length, 1);
  chk('an empty baseline flags every oversized file', evaluate(files, []).regressions.length, 2);
  chk('a file exactly AT the limit is not over it', evaluate([{ path: 'src/x.ts', lines: 500 }], []).regressions.length, 0);

  // The controls that matter: real child processes, real exit codes.
  const self = fileURLToPath(import.meta.url);
  const control = spawnSync(process.execPath, [self, '--json'], { cwd: REPO, encoding: 'utf8' });
  chk('control: the real gate exits 0 against the committed baseline', control.status, 0);

  const mutant = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {evaluate} from ${JSON.stringify(self)};
       const r = evaluate([{path:'src/brand_new.ts', lines: 501}], []);
       process.exit(r.regressions.length ? 1 : 0);`,
    ],
    { cwd: REPO, encoding: 'utf8' },
  );
  chk('mutant: an unbaselined 501-line file exits 1', mutant.status, 1);

  const failed = controls.filter((c) => !c).length;
  console.log(`\n${controls.length - failed}/${controls.length} controls passed`);
  return failed ? 1 : 0;
}

// IMPORT-SAFE BY CONSTRUCTION. Without this guard, `import`ing the module to test `evaluate` runs
// the CLI block first and calls process.exit() before the caller's assertion is ever reached — which
// is exactly how the mutant control below reported a false 0 on its first run. A gate whose own
// self-test cannot observe it is the class this file exists to prevent, so the guard is load-bearing.
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!IS_MAIN) {
  // Imported for its exports only. Do nothing else.
} else {

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) process.exit(selfTest());

const res = run({ update: argv.includes('--update') });
if (argv.includes('--json')) {
  console.log(JSON.stringify(res, null, 2));
} else if (res.status === 'CANNOT_MEASURE') {
  console.log(`CANNOT MEASURE: ${res.reason} (exit 2)`);
} else if (res.status === 'UPDATED') {
  console.log(`baseline updated: ${res.count} file(s) over ${LIMIT} lines`);
} else {
  console.log(
    `source-file-size ratchet: ${res.over}/${res.total} over ${LIMIT} lines, ` +
      `${res.regressions.length} NEW -> ${res.status}`,
  );
  for (const r of res.regressions) console.log(`  NEW OVER LIMIT  ${r.path}  ${r.lines} lines`);
  if (res.graduated.length) {
    console.log(`  ${res.graduated.length} baselined path(s) no longer over the limit — run --update to tighten`);
  }
}
process.exit(res.exit);

} // end IS_MAIN
