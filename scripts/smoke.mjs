#!/usr/bin/env node
// smoke.mjs — the x-backend INNER-LOOP tier. Hard budget: 30 seconds wall-clock.
//
// WHY THIS EXISTS. `npm run ci-local` is ~450s and `.husky/pre-push` is its only trigger, so the
// real choice a developer faces is 7.5 minutes or nothing. That is why people reach for
// `--no-verify`. This tier is the third option: short enough to sit in the edit/save loop.
//
// WHAT IT IS NOT. It is not the cheap half of ci-local. Every defect that reached production in
// this estate lived at a JUNCTION where two components must agree, and unit tests cannot see those
// by construction:
//
//   junction 1 · session entitlement resolution. `session.ts` gated a per-(user, workspace)
//                question on a per-user GLOBAL state. Those agree only for a user who owns no
//                workspace — every design partner owns one, so the branch was UNREACHABLE for
//                every real customer while 1,608 tests passed. The store had 7 green tests the
//                whole time: store coverage cannot see a caller that never calls.
//   junction 2 · frontend<->backend handshake pair. A 12.6-day and a 42-hour outage, both sides
//                individually "correct".
//   junction 3 · tenant isolation. A customer manifest passing through operator `src/` ships
//                operator construction IP into a publicly served customer bundle.
//
// So the steps below are ordered by JUNCTION VALUE, not by cost. The entitlement matrix is the
// single most expensive step here (~9.4s of the budget) and it is the first one in, because it is
// the only check in this repo that drives the real route end-to-end across the populations that
// reach it rather than testing the store in isolation.
//
// WHAT IS DELIBERATELY OUT.
//   · the full Workers suite (194 files) — that IS the 7.5-minute tier.
//   · verify-cross-tenant-rls-proof — correctly exits 2 without a live disposable Postgres, so on
//     every developer machine it would pin smoke at CANNOT_MEASURE forever. It stays in ci-local.
//   · anything needing the network. Smoke must work on a plane.
//
// BUDGET. 30s is a wall, not a target. If a step pushes the total past it, CUT CONTENTS — a smoke
// tier that takes two minutes is just a slow gate nobody runs. Going over budget is a FAILURE
// (exit 1), because a budget that never bites is decoration and erodes silently.
//
// EXIT CODES.  0 = measured clean   1 = measured, something failed (or over budget)
//              2 = COULD NOT MEASURE — a step could not read its subject. Distinct on purpose:
//                  "I could not run the check" must never render as "the check passed".
//              When both occur, 1 wins the exit code and every exit-2 step is still named.
//
// NOT WIRED INTO pre-push ON PURPOSE. pre-push already runs ci-local. Smoke is for the inner loop
// and pre-commit; stacking it on pre-push would only add seconds to the run people bypass.
//
//   npm run smoke
//   npm run smoke -- --json
//   npm run smoke -- --only=entitlement,tenant-isolation
//   npm run smoke -- --self-test     # proves smoke goes RED on a seeded defect and green clean
//
// ZERO NEW DEPENDENCIES: node: builtins only (vitest and tsc are existing devDependencies).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const JSON_OUT = argv.includes('--json');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg
  ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean))
  : null;

const BUDGET_MS = Number(process.env.XLOOOP_SMOKE_BUDGET_MS || 30000);

// ── the self-test seam ───────────────────────────────────────────────────────────────────────────
// The self-test needs to point ONE step at a mutated subject to observe smoke go red end-to-end.
// That seam is refused outside a self-test child, and refused LOUDLY (exit 2, "cannot measure")
// rather than ignored — an ignored override is a real run silently weakened by a stray env var.
const SUBJECT = process.env.XLOOOP_SMOKE_SUBJECT || '';
const SELF_TEST_CHILD = process.env.XLOOOP_SMOKE_SELF_TEST_CHILD === '1';
if (SUBJECT && !SELF_TEST_CHILD && !SELF_TEST) {
  console.error('\n  CANNOT MEASURE — XLOOOP_SMOKE_SUBJECT is a --self-test seam and is refused during a real run.\n');
  process.exit(2);
}

const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs');

// ── the steps ────────────────────────────────────────────────────────────────────────────────────
// `subject` marks the one step the self-test can redirect. `why` is the junction it defends.
const STEPS = [
  {
    id: 'entitlement',
    label: 'junction 1 · session invite entitlement matrix (the route precondition, end-to-end)',
    why: 'drives the real session route across the populations that reach it; the defect this pins was unreachable for every real customer while 1,608 tests passed',
    cmd: process.execPath,
    args: [VITEST, 'run', '--config', 'vitest.workers.config.ts',
      'src/workers/__tests__/session-invite-entitlement-matrix.test.ts'],
  },
  {
    id: 'tenant-isolation',
    label: 'junction 3 · tenant source isolation',
    why: 'a CUSTOMER manifest must never pass through operator src/ or scripts/ into a publicly served bundle',
    cmd: process.execPath,
    args: ['scripts/verify-tenant-source-isolation.mjs'],
    subject: (p) => ['--manifest-dir=' + p],
  },
  {
    id: 'handshake-pair',
    label: 'junction 2 · frontend/API pair refusal controls (offline fixture server)',
    why: 'the deploy gate must REFUSE a frontend compiled against a different backend sha — the 12.6-day and 42-hour outage class',
    cmd: process.execPath,
    args: ['scripts/verify-frontend-pair-before-api-deploy.mjs', '--self-test'],
  },
  {
    id: 'boundary',
    label: 'backend boundary',
    why: 'no worker may import a frontend layer, and shadow-only authority claims must not go stale',
    cmd: process.execPath,
    args: ['scripts/verify-backend-boundary.mjs'],
  },
  {
    id: 'contract',
    label: 'API contract artifact',
    why: 'the emitted contract is the SSOT the frontend handshake compares against',
    cmd: process.execPath,
    args: ['scripts/verify-api-contract-artifact.mjs'],
  },
  {
    id: 'self-reference',
    label: 'meta-gate P-2 · gate self-reference',
    why: 'a gate may not assert a function it itself defines; new violations fail against a frozen baseline',
    cmd: process.execPath,
    args: ['scripts/verify-gate-self-reference.mjs'],
  },
  {
    id: 'typecheck',
    label: 'Workers TypeScript',
    why: 'the broadest net per second in the repo; last because it is the second-slowest step',
    cmd: 'npm',
    args: ['run', 'typecheck'],
  },
];

function runSteps(steps) {
  const results = [];
  for (const step of steps) {
    const args = step.subject && SUBJECT ? [...step.args, ...step.subject(SUBJECT)] : step.args;
    const t0 = Date.now();
    // Exit codes are read from spawnSync's `status`, never from a pipeline: `cmd | tail` reports
    // TAIL's status and has produced false greens in this estate.
    const r = spawnSync(step.cmd, args, {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, XLOOOP_SMOKE_SUBJECT: '', XLOOOP_SMOKE_SELF_TEST_CHILD: '' },
    });
    const ms = Date.now() - t0;
    // A child killed by a signal has status null. That is not "clean", and it is not a measured
    // failure either — it is a run that did not happen. Cannot-measure.
    const status = r.status === null ? 2 : r.status;
    results.push({
      id: step.id, label: step.label, why: step.why, ms, status, signal: r.signal || null,
      out: (r.stdout || '') + (r.stderr || ''),
    });
  }
  return results;
}

function report(results) {
  const total = results.reduce((a, r) => a + r.ms, 0);
  const failed = results.filter((r) => r.status === 1);
  const unmeasured = results.filter((r) => r.status !== 0 && r.status !== 1);
  const overBudget = total > BUDGET_MS;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      verdict: failed.length || overBudget ? 'FAIL' : unmeasured.length ? 'CANNOT_MEASURE' : 'PASS',
      total_ms: total, budget_ms: BUDGET_MS, over_budget: overBudget,
      steps: results.map(({ out, ...rest }) => rest),
    }, null, 2));
  } else {
    console.log('\n  smoke · x-backend · budget ' + (BUDGET_MS / 1000).toFixed(0) + 's');
    console.log('  ' + '-'.repeat(96));
    for (const r of results) {
      const verdict = r.status === 0 ? 'PASS' : r.status === 1 ? 'FAIL' : 'CANNOT MEASURE';
      console.log('  ' + verdict.padEnd(15) + String(r.ms).padStart(6) + 'ms  ' + r.id.padEnd(18) + r.label);
      if (r.status !== 0) {
        for (const line of r.out.split('\n').filter((l) => /FAIL|CANNOT MEASURE|error|✗/i.test(l)).slice(0, 6)) {
          console.log('                              ↳ ' + line.trim().slice(0, 140));
        }
      }
    }
    console.log('  ' + '-'.repeat(96));
    const pct = ((total / BUDGET_MS) * 100).toFixed(0);
    console.log('  TOTAL' + String(total).padStart(16) + 'ms  ' + (total / 1000).toFixed(1) + 's of the '
      + (BUDGET_MS / 1000).toFixed(0) + 's budget (' + pct + '%)');
    if (overBudget) {
      console.error('\n  BUDGET EXCEEDED — smoke took ' + (total / 1000).toFixed(1) + 's against a '
        + (BUDGET_MS / 1000).toFixed(0) + 's budget.\n'
        + '  CUT CONTENTS rather than raising the budget: a smoke tier that takes two minutes is a slow\n'
        + '  gate nobody runs, which is the failure this tier exists to fix.\n'
        + '  (XLOOOP_SMOKE_BUDGET_MS overrides it for a genuinely slower machine.)');
    }
    if (unmeasured.length) {
      console.error('\n  CANNOT MEASURE: ' + unmeasured.map((r) => r.id + ' (exit ' + r.status
        + (r.signal ? '/' + r.signal : '') + ')').join(', ')
        + '\n  A step that could not read its subject is not a step that passed.');
    }
    if (!failed.length && !unmeasured.length && !overBudget) console.log('  smoke PASS\n');
    else console.log('');
  }

  if (failed.length || overBudget) return 1;
  if (unmeasured.length) return 2;
  return 0;
}

// ── --self-test · smoke must be OBSERVED going red ───────────────────────────────────────────────
// A smoke tier nobody has watched fail is decoration. Every case below re-runs SMOKE ITSELF as a
// CHILD PROCESS and reads spawnSync's `status`.
//
// The mutant is built from the REAL tenant manifests: they are copied to a temp dir and the
// CUSTOMER manifest gains `src/` in passthrough_dirs — the exact defect the gate exists to catch,
// and the exact shape the gate's own self-test uses. It is not a hand-written fixture pretending
// to be a manifest; the anchor (a real customer manifest with a real passthrough_dirs array) is
// verified present first, so this control cannot rot into proving nothing.
if (SELF_TEST) {
  const self = fileURLToPath(import.meta.url);
  const MANIFEST_DIR = resolve(REPO, 'data', '_tenant-manifests');
  if (!existsSync(MANIFEST_DIR)) {
    console.error('\n  CANNOT MEASURE — data/_tenant-manifests is absent; the self-test has no real subject to mutate.\n');
    process.exit(2);
  }
  const OPERATOR_WORKSPACE = 'mbp-private';
  const files = readdirSync(MANIFEST_DIR).filter((f) => f.endsWith('.json'));
  const manifests = files.map((f) => ({ file: f, json: JSON.parse(readFileSync(join(MANIFEST_DIR, f), 'utf8')) }));
  const customer = manifests.find((m) => !(m.json.owned_workspaces || []).includes(OPERATOR_WORKSPACE)
    && Array.isArray(m.json.passthrough_dirs));
  if (!customer) {
    console.error('\n  CANNOT MEASURE — no CUSTOMER tenant manifest with a passthrough_dirs array was found in\n'
      + '  data/_tenant-manifests. This self-test would mutate nothing and prove nothing.\n');
    process.exit(2);
  }

  const dir = mkdtempSync(join(tmpdir(), 'xlooop-smoke-selftest-'));
  const mutantDir = join(dir, 'manifests');
  mkdirSync(mutantDir, { recursive: true });
  for (const m of manifests) {
    const json = JSON.parse(JSON.stringify(m.json));
    // The mutation: this customer bundle now ships operator worker source.
    if (m.file === customer.file) json.passthrough_dirs = [...json.passthrough_dirs, 'src/'];
    writeFileSync(join(mutantDir, m.file), JSON.stringify(json, null, 2));
  }

  const runSmoke = (extraArgs, env) => spawnSync(process.execPath, [self, ...extraArgs], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env },
  });

  const rows = [];
  const record = (label, ok, detail) => rows.push({ label, ok, detail });

  console.log("\n  smoke --self-test · every case OBSERVES smoke's own exit code from a child process");
  console.log('  ' + '-'.repeat(96));

  // 1 · CONTROL — the full, unmutated smoke tier must be GREEN. Without this, a smoke tier that
  //     always failed would "detect" every mutant and prove nothing at all.
  const control = runSmoke([], { XLOOOP_SMOKE_SUBJECT: '', XLOOOP_SMOKE_SELF_TEST_CHILD: '' });
  record('CONTROL · the full unmutated smoke tier exits 0', control.status === 0,
    'exit=' + control.status + (control.status !== 0 ? '\n' + (control.stdout || '') + (control.stderr || '') : ''));

  // 2 · MUTANT — a real customer manifest shipping operator src/ must drive smoke to exit 1.
  const mutant = runSmoke(['--only=tenant-isolation'],
    { XLOOOP_SMOKE_SUBJECT: mutantDir, XLOOOP_SMOKE_SELF_TEST_CHILD: '1' });
  record("MUTANT · a real customer manifest gaining 'src/' drives smoke to exit 1",
    mutant.status === 1, 'exit=' + mutant.status);

  // 3 · CANNOT MEASURE — an absent subject must be exit 2, never 0 and never 1. This is the whole
  //     reason the two codes are distinct: an unreadable subject is not a clean subject.
  const missing = runSmoke(['--only=tenant-isolation'],
    { XLOOOP_SMOKE_SUBJECT: join(dir, 'no-such-dir'), XLOOOP_SMOKE_SELF_TEST_CHILD: '1' });
  record('CANNOT MEASURE · an absent subject drives smoke to exit 2 (not 0, not 1)',
    missing.status === 2, 'exit=' + missing.status);

  // 4 · the self-test seam must be REFUSED in a real run, or a stray env var silently weakens smoke.
  const seam = runSmoke(['--only=tenant-isolation'],
    { XLOOOP_SMOKE_SUBJECT: mutantDir, XLOOOP_SMOKE_SELF_TEST_CHILD: '' });
  record('SEAM · XLOOOP_SMOKE_SUBJECT outside a self-test child is refused with exit 2',
    seam.status === 2, 'exit=' + seam.status);

  // 5 · the budget wall must actually bite, or "30 seconds" is a comment.
  const budget = runSmoke(['--only=tenant-isolation'], { XLOOOP_SMOKE_BUDGET_MS: '1' });
  record('BUDGET · a total over XLOOOP_SMOKE_BUDGET_MS drives exit 1 (the wall is real)',
    budget.status === 1, 'exit=' + budget.status);

  // 6 · an --only that matches nothing must be cannot-measure, not a vacuous green. Zero steps run
  //     is the false-zero shape: "measured clean" with an empty input set.
  const empty = runSmoke(['--only=__no-such-step__'], {});
  record('EMPTY INPUT SET · --only matching zero steps exits 2, never 0',
    empty.status === 2, 'exit=' + empty.status);

  rmSync(dir, { recursive: true, force: true });

  for (const r of rows) {
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL').padEnd(6) + '  ' + r.label + '  ' + (r.ok ? '' : r.detail));
  }
  console.log('  ' + '-'.repeat(96));
  const bad = rows.filter((r) => !r.ok);
  if (bad.length) {
    console.error('\n  smoke --self-test FAIL · ' + bad.length + '/' + rows.length + ' controls did not hold.\n');
    process.exit(1);
  }
  console.log('  smoke --self-test PASS · ' + rows.length + '/' + rows.length
    + ' (green clean, red on a real seeded defect, exit 2 on an unreadable subject,\n'
    + '  seam refused outside a self-test child, budget wall bites, empty input set is not a green)\n');
  process.exit(0);
}

const selected = ONLY ? STEPS.filter((s) => ONLY.has(s.id)) : STEPS;
if (!selected.length) {
  console.error('\n  CANNOT MEASURE — --only matched zero steps. Known ids: '
    + STEPS.map((s) => s.id).join(', ') + '\n');
  process.exit(2);
}
process.exit(report(runSteps(selected)));
