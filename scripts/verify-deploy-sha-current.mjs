#!/usr/bin/env node
// verify-deploy-sha-current.mjs · S1 rectification (260706): the stale-checkout deploy gate.
//
// FAILURE CLASS: `npm run deploy:api` stamps BUILD_SHA from the LOCAL git HEAD. On 260706 a deploy
// from a stale primary checkout shipped 7266a6d5 instead of origin/main's d7d37db7 — old code that
// LOOKED healthy (401-not-500) but silently lacked the release. Caught only by a manual live
// build-SHA check. This gate makes that class mechanically impossible: it runs BEFORE wrangler
// deploy and FAILS unless local HEAD == origin/main (fetched fresh).
//
// Override (deliberate non-main deploy, e.g. canary/rollback): XLOOOP_DEPLOY_SHA_OVERRIDE=1.
// Fail-CLOSED on git/network errors — a deploy must never proceed on unverified state.

import { execSync } from 'node:child_process';

if (process.env.XLOOOP_DEPLOY_SHA_OVERRIDE === '1') {
  console.log('⚠ deploy-sha-current · OVERRIDDEN (XLOOOP_DEPLOY_SHA_OVERRIDE=1) — deploying non-main HEAD deliberately');
  process.exit(0);
}

const run = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 30_000 }).trim();

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
