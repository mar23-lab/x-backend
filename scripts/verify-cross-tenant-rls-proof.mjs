#!/usr/bin/env node
// verify-cross-tenant-rls-proof.mjs — the cross-tenant RLS proof, with the silent skip removed.
//
// THE DEFECT. `src/workers/__tests__/operational-spine-live-rls.test.ts` is the only proof in this
// repository that one tenant cannot read another tenant's rows through the real route ->
// WorkersDalAdapter -> Postgres path. It is written as:
//
//     const describeLive = shouldRun ? describe : describe.skip;
//
// so on any machine without XLOOOP_RUN_LIVE_RLS=1 it registers as SKIPPED. Vitest reports a
// fully-skipped file as a green run, and the file was in no blocking chain at all. The estate
// therefore had a cross-tenant isolation proof whose normal state was "did not run, reported clean".
// That is the exact false-zero class Stage 2 exists to remove: could-not-measure rendered as
// measured-clean.
//
// WHY THIS IS A RUNNER AND NOT A NEW ci-local ENTRY. The proof genuinely needs a live Postgres: it
// CREATEs a temporary non-bypass role and probe rows on a disposable Neon branch. It cannot run
// offline, and it must NEVER be pointed at production — the deploy chain is therefore the wrong home
// for it too (deploy:api runs against the prod DSN; this test would create roles there). An
// always-red entry in ci-local would simply be bypassed, and this estate has already measured two
// advisory controls at 100% would-block across 270 and 174 runs that were never promoted. So:
//
//   - CAN measure  -> run it, and report green ONLY if assertions actually EXECUTED.
//   - CANNOT measure -> exit 2. Never 0. The absence is stated, not swallowed.
//
// THE LOAD-BEARING PART. Exit 0 requires vitest to report at least one PASSED test and ZERO pending
// ones for these files. A run that skips everything and exits 0 — the state that made this proof
// worthless — is now itself a failure. Wired into `verify:trust-proofs:live` (the operator-gated
// path that already fails closed on missing DSNs); ci-local runs the SELF-TEST, which is offline-
// safe and proves this runner cannot be talked into a false green.
//
// EXIT CODES.  0 = measured clean   1 = measured, failed   2 = COULD NOT MEASURE
//
//   node scripts/verify-cross-tenant-rls-proof.mjs
//   node scripts/verify-cross-tenant-rls-proof.mjs --json
//   node scripts/verify-cross-tenant-rls-proof.mjs --self-test

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const selfTest = argv.includes('--self-test');

const PROOF_FILES = [
  'src/workers/__tests__/operational-spine-live-rls.test.ts',
  'src/workers/__tests__/role-skill-evidence-live-rls.test.ts',
];
const REQUIRED_DSNS = ['DATABASE_URL', 'XLOOOP_RLS_APP_DATABASE_URL'];

function emit(status, code, payload) {
  if (asJson) {
    console.log(JSON.stringify({ schema_id: 'xlooop.cross_tenant_rls_proof.v1', status, ...payload }, null, 2));
  } else {
    console.log(`\n  CROSS-TENANT RLS PROOF · ${status}`);
    console.log('  ' + '-'.repeat(78));
    for (const [key, value] of Object.entries(payload)) {
      console.log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
    console.log('  ' + '-'.repeat(78) + '\n');
  }
  process.exit(code);
}

// =================================================================================================
// THE ONLY THING THAT MAKES A TEST RUN MEAN ANYTHING: DID ASSERTIONS EXECUTE?
// =================================================================================================
// Vitest exits 0 for a file whose every test is skipped. This classifier is the reason exit 0 from
// the child is not accepted at face value. It is exported-by-position (pure, argument-in/verdict-out)
// so the self-test can drive it with synthetic reporter payloads and observe each verdict.
export function classifyVitestRun(exitStatus, reportJson) {
  if (!reportJson || typeof reportJson !== 'object') {
    return { verdict: 'CANNOT_MEASURE', reason: 'vitest produced no parseable JSON report' };
  }
  const passed = Number(reportJson.numPassedTests || 0);
  const failed = Number(reportJson.numFailedTests || 0);
  const pending = Number(reportJson.numPendingTests || 0);
  const total = Number(reportJson.numTotalTests || 0);

  if (failed > 0) {
    return { verdict: 'FAIL', reason: `${failed} cross-tenant assertion(s) failed`, passed, failed, pending, total };
  }
  if (passed === 0) {
    return {
      verdict: 'CANNOT_MEASURE',
      reason: `vitest exited ${exitStatus} with ZERO executed assertions (${pending} skipped of ${total}) — `
        + 'a fully-skipped cross-tenant proof is not a passing one',
      passed, failed, pending, total,
    };
  }
  if (pending > 0) {
    return {
      verdict: 'CANNOT_MEASURE',
      reason: `${pending} cross-tenant assertion(s) were SKIPPED (only ${passed} ran) — a partial proof cannot report clean`,
      passed, failed, pending, total,
    };
  }
  if (exitStatus !== 0) {
    return { verdict: 'FAIL', reason: `vitest exited ${exitStatus} despite reporting no failed tests`, passed, failed, pending, total };
  }
  return { verdict: 'PASS', reason: `${passed} cross-tenant assertion(s) executed and passed`, passed, failed, pending, total };
}

// =================================================================================================
// SELF-TEST — offline, and it observes a red through a child process
// =================================================================================================
function runSelfTest() {
  const problems = [];

  // (1) The classifier. These are the three verdicts the whole gate rests on.
  const cases = [
    { label: 'fully skipped run', status: 0, report: { numTotalTests: 12, numPassedTests: 0, numFailedTests: 0, numPendingTests: 12 }, want: 'CANNOT_MEASURE' },
    { label: 'partially skipped run', status: 0, report: { numTotalTests: 12, numPassedTests: 8, numFailedTests: 0, numPendingTests: 4 }, want: 'CANNOT_MEASURE' },
    { label: 'no report at all', status: 0, report: null, want: 'CANNOT_MEASURE' },
    { label: 'genuine failure', status: 1, report: { numTotalTests: 12, numPassedTests: 11, numFailedTests: 1, numPendingTests: 0 }, want: 'FAIL' },
    { label: 'green exit with no report', status: 0, report: undefined, want: 'CANNOT_MEASURE' },
    { label: 'fully executed clean run', status: 0, report: { numTotalTests: 12, numPassedTests: 12, numFailedTests: 0, numPendingTests: 0 }, want: 'PASS' },
  ];
  for (const testCase of cases) {
    const got = classifyVitestRun(testCase.status, testCase.report).verdict;
    if (got !== testCase.want) problems.push(`classifier: ${testCase.label} -> ${got}, expected ${testCase.want}`);
  }

  // (2) The gate END-TO-END with the DSNs absent must exit 2, never 0. Observed through a child
  // process with the environment scrubbed, because that is the state every offline machine is in and
  // the state in which this proof used to report green.
  const scrubbed = { ...process.env };
  for (const name of REQUIRED_DSNS) delete scrubbed[name];
  const withoutDsn = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--json'], { encoding: 'utf8', env: scrubbed });
  if (withoutDsn.status !== 2) {
    problems.push(`gate with no DSN exited ${withoutDsn.status}, expected 2 (cannot measure) — a missing database must never render as clean`);
  } else {
    console.log('  observed        no DSN present                                exit=2  CANNOT_MEASURE');
  }

  // (3) The proof files must still exist and still carry the conditional-skip this gate compensates
  // for. If someone deletes the test, this runner would otherwise keep exiting 2 forever and look
  // like an environment problem rather than a deleted proof.
  for (const relative of PROOF_FILES) {
    const absolute = join(REPO, relative);
    if (!existsSync(absolute)) {
      problems.push(`proof file missing: ${relative} — this runner would report CANNOT_MEASURE forever and hide a deleted proof`);
      continue;
    }
    const source = readFileSync(absolute, 'utf8');
    if (!/describe\.skip|skipIf|XLOOOP_RUN_LIVE_RLS/.test(source)) {
      problems.push(`${relative} no longer gates itself on XLOOOP_RUN_LIVE_RLS — re-check whether this runner is still needed`);
    }
  }

  if (problems.length) {
    console.error('\nverify-cross-tenant-rls-proof --self-test FAIL');
    for (const problem of problems) console.error(`  x ${problem}`);
    process.exit(1);
  }
  console.log(`\nverify-cross-tenant-rls-proof — self-test PASS (${cases.length} classifier verdicts, missing-DSN observed exit 2)`);
  process.exit(0);
}

if (selfTest) runSelfTest();

// =================================================================================================
// REAL RUN
// =================================================================================================
const missing = REQUIRED_DSNS.filter((name) => !process.env[name]);
if (missing.length) {
  emit('CANNOT_MEASURE', 2, {
    reason: 'the cross-tenant RLS proof requires a live, DISPOSABLE Postgres and cannot run here',
    missing,
    proof_files: PROOF_FILES,
    remediation:
      "DATABASE_URL='postgres://…owner…' XLOOOP_RLS_APP_DATABASE_URL='postgres://…xlooop_app…' "
      + 'npm run verify:cross-tenant-rls-proof   # NEVER point this at production — it creates roles and probe rows',
  });
}

for (const relative of PROOF_FILES) {
  if (!existsSync(join(REPO, relative))) {
    emit('CANNOT_MEASURE', 2, { reason: `proof file missing: ${relative}`, proof_files: PROOF_FILES });
  }
}

const reportPath = join(mkdtempSync(join(tmpdir(), 'xlooop-cross-tenant-')), 'vitest.json');
const run = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'vitest.workers.config.ts', '--no-file-parallelism',
    '--reporter=json', `--outputFile=${reportPath}`, ...PROOF_FILES],
  { cwd: REPO, encoding: 'utf8', env: { ...process.env, XLOOOP_RUN_LIVE_RLS: '1' } },
);

let report = null;
try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* classifier handles it */ }
rmSync(dirname(reportPath), { recursive: true, force: true });

const outcome = classifyVitestRun(run.status, report);
if (outcome.verdict === 'PASS') {
  emit('PASS', 0, { reason: outcome.reason, executed: outcome.passed, proof_files: PROOF_FILES });
}
if (outcome.verdict === 'FAIL') {
  console.error(run.stdout || '');
  console.error(run.stderr || '');
  emit('FAIL', 1, { reason: outcome.reason, ...outcome, proof_files: PROOF_FILES });
}
console.error(run.stdout || '');
console.error(run.stderr || '');
emit('CANNOT_MEASURE', 2, { reason: outcome.reason, ...outcome, proof_files: PROOF_FILES });
