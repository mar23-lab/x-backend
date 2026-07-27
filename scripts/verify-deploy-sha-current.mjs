#!/usr/bin/env node
// verify-deploy-sha-current.mjs · S1 rectification (260706): the stale-checkout deploy gate.
//
// FAILURE CLASS: `npm run deploy:api` stamps BUILD_SHA from the LOCAL git HEAD. On 260706 a deploy
// from a stale primary checkout shipped 7266a6d5 instead of origin/main's d7d37db7 — old code that
// LOOKED healthy (401-not-500) but silently lacked the release. Caught only by a manual live
// build-SHA check. This gate makes that class mechanically impossible: it runs BEFORE wrangler
// deploy and FAILS unless local HEAD == origin/main (fetched fresh).
//
// Override (deliberate non-main deploy, e.g. canary/rollback): XLOOOP_DEPLOY_SHA_OVERRIDE=1
// PLUS a non-empty XLOOOP_DEPLOY_SHA_OVERRIDE_REASON. The override now writes a durable waiver
// receipt; it is no longer a silent exit.
// Fail-CLOSED on git/network errors — a deploy must never proceed on unverified state.
//
// 260727 HARDENING — why the override needed a floor.
// Measured on 260727: production was serving 3d7ade27, which is NOT an ancestor of origin/main
// (44 main commits missing, 7 commits sideways, fork point 04b28196). This gate is not what failed —
// the equality check below is STRICTER than ancestry and it fired correctly. What failed is that the
// override answered it by exiting 0 on a console warning, requiring no reason and leaving no durable
// record. So the estate could not answer "who put production off-main, when, and why" from any
// artifact. An override that leaves no receipt is not an exception path; it is a hole with no floor.
// Fix: require a reason, and persist a waiver receipt next to the deployment-authorization store in
// the git COMMON dir (shared across worktrees, so a replay from another checkout still sees it).

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const run = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 30_000 }).trim();

/** Durable waiver receipt. Written to the git common dir so every worktree observes it. */
function writeWaiverReceipt(fields) {
  try {
    const commonDir = run('git rev-parse --path-format=absolute --git-common-dir');
    const dir = join(commonDir, 'xlooop-deploy-sha-waivers');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `${stamp}-${(fields.head || 'unknown').slice(0, 12)}.json`);
    writeFileSync(path, `${JSON.stringify({
      schema_id: 'xlooop.deploy_sha_waiver.v1',
      waived_gate: 'verify-deploy-sha-current',
      ...fields,
    }, null, 2)}\n`);
    return path;
  } catch (err) {
    return `UNWRITABLE:${err.message}`;
  }
}

if (process.env.XLOOOP_DEPLOY_SHA_OVERRIDE === '1') {
  const reason = (process.env.XLOOOP_DEPLOY_SHA_OVERRIDE_REASON || '').trim();
  if (!reason) {
    console.error('✗ deploy-sha-current · OVERRIDE REFUSED — XLOOOP_DEPLOY_SHA_OVERRIDE=1 requires a reason.');
    console.error('    Set XLOOOP_DEPLOY_SHA_OVERRIDE_REASON="<why this non-main sha is being deployed>".');
    console.error('    An override with no recorded reason cannot be audited, so it is not permitted.');
    process.exit(1);
  }
  let head = 'unknown';
  let remoteMain = 'unknown';
  let onMain = null;
  try {
    head = run('git rev-parse HEAD');
    remoteMain = run('git ls-remote origin -h refs/heads/main').split('\t')[0];
    // Ancestry, not presence: is the sha we are about to deploy reachable from main at all?
    // Equality already implies this, so it only ever matters on the override path — which is
    // exactly where production went off-main.
    onMain = (() => {
      try { run(`git merge-base --is-ancestor ${head} ${remoteMain}`); return true; } catch { return false; }
    })();
  } catch { /* receipt still records what is known; never block the operator's deliberate override */ }
  const receipt = writeWaiverReceipt({
    head, remote_main: remoteMain, head_is_ancestor_of_main: onMain, reason,
    waived_at: new Date().toISOString(),
    consequence: onMain === false
      ? 'DEPLOYING A SHA THAT IS NOT REACHABLE FROM origin/main — production will be a fork of main until reconciled'
      : 'non-main HEAD deployed deliberately',
  });
  console.log('⚠ deploy-sha-current · OVERRIDDEN — waiver receipt written, this is now auditable');
  console.log(`    reason  : ${reason}`);
  console.log(`    on main : ${onMain === null ? 'unknown' : onMain}`);
  if (onMain === false) console.log('    ⚠ this sha is NOT an ancestor of origin/main — production will FORK from main');
  console.log(`    receipt : ${receipt}`);
  process.exit(0);
}

try {
  const head = run('git rev-parse HEAD');
  // ls-remote = ground truth from the remote, immune to a stale local origin/main ref.
  const remoteMain = run('git ls-remote origin -h refs/heads/main').split('\t')[0];
  if (!head || !remoteMain) throw new Error('empty sha from git');
  if (head !== remoteMain) {
    console.error('✗ deploy-sha-current · FAIL — this checkout is NOT at origin/main; deploying would ship stale/unpushed code.');
    console.error(`    local HEAD  : ${head.slice(0, 12)}`);
    console.error(`    origin/main : ${remoteMain.slice(0, 12)}`);
    console.error('  Fix: deploy from a checkout at origin/main (git fetch && git status), or push first.');
    console.error('  Deliberate exception: XLOOOP_DEPLOY_SHA_OVERRIDE=1 npm run deploy:api');
    process.exit(1);
  }
  console.log(`☑ deploy-sha-current · PASS · HEAD == origin/main (${head.slice(0, 12)})`);
  process.exit(0);
} catch (err) {
  console.error(`✗ deploy-sha-current · FAIL-CLOSED — could not verify HEAD vs origin/main: ${err.message}`);
  console.error('  A deploy must not proceed on unverified git state. Check network/git and retry.');
  process.exit(1);
}
