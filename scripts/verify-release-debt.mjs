#!/usr/bin/env node
// verify-release-debt.mjs — the alarm that would have caught the 260801-03 programme failure.
//
// WHAT HAPPENED (measured, not hypothetical). Between 2026-08-01 and 2026-08-03, twelve backend PRs
// (#141-#151) and thirteen frontend PRs (#116-#129) were merged, individually verified, and never
// deployed. Production sat at 9f4a03bf while main reached 3bdf749c — 22 backend and 27 frontend
// commits of undeployed delta. Five consecutive agent sessions each ended by requesting the same
// deployment approval; none was answered; each next session started from the merged-but-undeployed
// main and added more.
//
// Nothing in the estate ever said "you are N commits ahead of production and climbing." Worse, each
// session REPORTED "production confirmed unchanged" as reassurance — the number was visible the
// whole time and read as good news. That inversion is the defect this gate exists to remove.
//
// WHY IT COMPARES AGAINST /health AND NOT A LOCAL FILE. A recorded deploy sha in a repo file is a
// claim; `/health.build` is the deployed reality, injected at `npm run deploy:api` via --var
// BUILD_SHA. routes/health.ts:13-18 makes the same point for the same reason: never infer deploy
// state from a hardcoded constant, use a value that tracks reality. A gate that read a local
// receipt would have stayed green through the entire arc, because every receipt in the repo was
// accurate — accurate about a deploy that happened days earlier.
//
// POSTURE. Advisory by default so it can be adopted without blocking anyone mid-wave; set
// XLOOOP_RELEASE_DEBT_ENFORCE=1 to make it exit non-zero. It is NEVER fail-open on "could not
// check": an unreachable /health is reported as UNKNOWN and, under enforcement, is a failure —
// "could not check" must never read as "no debt", which is the false-zero class this estate keeps
// paying for.
//
//   node scripts/verify-release-debt.mjs
//   node scripts/verify-release-debt.mjs --self-test   # proves the threshold logic can go RED

import { execFileSync } from 'node:child_process';

const HEALTH_URL = process.env.XLOOOP_HEALTH_URL || 'https://api.xlooop.com/api/v1/health';
const WARN_AT = Number(process.env.XLOOOP_RELEASE_DEBT_WARN || 10);
const ENFORCE = process.env.XLOOOP_RELEASE_DEBT_ENFORCE === '1';
const selfTest = process.argv.includes('--self-test');

/** Pure decision function, so the threshold logic is testable without a network. */
export function assessReleaseDebt({ commitsAhead, warnAt, liveShaKnown }) {
  if (!liveShaKnown) {
    return { level: 'unknown', ok: false, reason: 'live_build_sha_unavailable' };
  }
  if (commitsAhead === 0) return { level: 'clean', ok: true, reason: 'deployed_head_matches' };
  if (commitsAhead < warnAt) return { level: 'ok', ok: true, reason: 'below_threshold' };
  return { level: 'debt', ok: false, reason: 'undeployed_backlog_over_threshold' };
}

function runSelfTest() {
  const controls = [
    [assessReleaseDebt({ commitsAhead: 0, warnAt: 10, liveShaKnown: true }).ok, true, 'clean'],
    [assessReleaseDebt({ commitsAhead: 3, warnAt: 10, liveShaKnown: true }).ok, true, 'below threshold'],
    [assessReleaseDebt({ commitsAhead: 10, warnAt: 10, liveShaKnown: true }).ok, false, 'at threshold is debt'],
    [assessReleaseDebt({ commitsAhead: 22, warnAt: 10, liveShaKnown: true }).ok, false, 'the measured 260803 backlog'],
    // "Could not check" must NOT read as "no debt".
    [assessReleaseDebt({ commitsAhead: 0, warnAt: 10, liveShaKnown: false }).ok, false, 'unknown is not clean'],
  ];
  const failed = controls.filter(([actual, expected]) => actual !== expected);
  if (failed.length > 0) {
    console.error(`verify-release-debt self-test FAIL: ${failed.map((r) => r[2]).join(', ')}`);
    process.exit(1);
  }
  console.log('verify-release-debt self-test PASS · clean/below/at-threshold/backlog/unknown controls');
}

async function main() {
  if (selfTest) return runSelfTest();

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  let liveSha = null;
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(15000) });
    if (res.ok) liveSha = (await res.json())?.build || null;
  } catch { /* handled below as UNKNOWN, never as clean */ }

  if (!liveSha || liveSha === 'dev') {
    const verdict = assessReleaseDebt({ commitsAhead: 0, warnAt: WARN_AT, liveShaKnown: false });
    console.error(`verify-release-debt · UNKNOWN · could not read a deployed sha from ${HEALTH_URL}`);
    console.error('  "could not check" is NOT "no debt" — treat this as unmeasured, not clean.');
    if (ENFORCE) process.exit(1);
    return void verdict;
  }

  let commitsAhead = null;
  try {
    commitsAhead = Number(
      execFileSync('git', ['rev-list', '--count', `${liveSha}..${head}`], { encoding: 'utf8' }).trim(),
    );
  } catch {
    console.error(`verify-release-debt · UNKNOWN · deployed sha ${liveSha.slice(0, 8)} is not in this repo`);
    console.error('  (fetch the remote, or the deployed build came from a different tree entirely)');
    if (ENFORCE) process.exit(1);
    return;
  }

  const verdict = assessReleaseDebt({ commitsAhead, warnAt: WARN_AT, liveShaKnown: true });
  const summary = `deployed ${liveSha.slice(0, 8)} · HEAD ${head.slice(0, 8)} · ${commitsAhead} commit(s) undeployed`;

  if (verdict.ok) {
    console.log(`verify-release-debt · ${verdict.level.toUpperCase()} · ${summary}`);
    return;
  }
  console.error(`verify-release-debt · RELEASE DEBT · ${summary} (threshold ${WARN_AT})`);
  console.error('  Every one of these commits is verified and running NOWHERE. This number going up');
  console.error('  is not reassurance that production is stable — it is the backlog compounding.');
  if (ENFORCE) process.exit(1);
}

main().catch((err) => {
  console.error(`verify-release-debt · ERROR · ${err instanceof Error ? err.message : String(err)}`);
  if (ENFORCE) process.exit(1);
});
