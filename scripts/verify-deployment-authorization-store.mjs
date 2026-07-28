#!/usr/bin/env node

// WHY THIS FILE SCRUBS THE GIT ENVIRONMENT (the defect it closes · validated 260728):
//
// This gate builds a THROWAWAY repo under os.tmpdir() and runs `git init` / `git add` /
// `git commit` in it. Passing `cwd` is NOT enough to keep those writes inside the throwaway.
// Git exports its per-invocation environment to hooks, child processes inherit it, and
// GIT_DIR OVERRIDES REPOSITORY DISCOVERY — so `cwd` is ignored outright.
//
// Observed: `npm run ci-local` under a hook that had GIT_DIR set made this gate commit its
// one-line "test fixture" README.md onto the branch being pushed (commit db08f3e, author
// `Xlooop verifier <verifier@localhost>`), and git shipped it to origin. The gate printed
// PASS while doing it. It missed `main` only because that branch was squash-merged — luck,
// not safety.
//
// The precise mechanism, reproduced in --self-test: with GIT_DIR set and GIT_WORK_TREE
// unset, git takes the child's cwd as the work tree. `git add README.md` therefore writes
// the tmpdir fixture into the ENCLOSING repo's index, and `git commit` lands it on the
// ENCLOSING repo's HEAD.
//
// WHY ENV-SCRUBBING AND NOT `-C` / `--git-dir` / `--work-tree`:
// `-C <dir>` only changes directory before running; GIT_DIR still wins over discovery, so
// `-C` alone fixes nothing. Explicit `--git-dir`/`--work-tree` would pin the repo, but they
// do NOT neutralise GIT_INDEX_FILE (observed as the RELATIVE value `.git/index`, which
// re-resolves against each new cwd), GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES
// or GIT_QUARANTINE_PATH — those keep steering the index and the object writes. Deleting the
// variables closes every one of them at a single site, and it cannot drift out of sync with
// the call sites the way a repeated flag pair does. So: one `gitEnv()`, one `runGit()`, and
// no raw execFileSync('git', …) anywhere in this file.
//
// (GIT_AUTHOR_*/GIT_COMMITTER_*/GIT_CONFIG_PARAMETERS also leak into hooks. They can skew a
// commit's identity but cannot redirect it into another repository, so they are out of scope
// here; this gate pins identity with explicit `-c user.name`/`-c user.email` regardless.)

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  consumeDeploymentAuthorization,
  deploymentAuthorizationStoreRoot,
  deploymentAuthorizationReceiptPath,
  isDeploymentAuthorizationConsumed,
} from './lib/deployment-authorization-store.mjs';
import { gitEnv } from './lib/git-env.mjs';

/** The ONLY way this file may invoke git. `env` is applied last so no caller can
 *  re-introduce a poisoned environment by passing its own `env`. */
function runGit(args, options = {}) {
  return execFileSync('git', args, { stdio: 'ignore', ...options, env: gitEnv() });
}

/** Read-only git for the self-test's before/after assertions — also scrubbed, so the
 *  measurement cannot be redirected by the same variables it is testing for. */
function readGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();
}

function runGate() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xlooop-deploy-authorization-'));
  const repoRoot = path.join(root, 'repo');
  const worktreeRoot = path.join(root, 'linked-worktree');
  const authorizationId = '36eb5d20-49d9-4ed9-b623-0f7250797244';
  const receipt = {
    schema_id: 'xlooop.deployment_authorization_receipt.v1',
    surface: 'api',
    authorization_id: authorizationId,
    state: 'reserved_before_deploy',
  };
  let replayRejected = false;
  let unsafePathRejected = false;

  try {
    runGit(['init', repoRoot]);
    writeFileSync(path.join(repoRoot, 'README.md'), 'deployment authorization test\n');
    runGit(['add', 'README.md'], { cwd: repoRoot });
    runGit(
      [
        '-c', 'user.name=Xlooop verifier',
        '-c', 'user.email=verifier@localhost',
        'commit', '-m', 'test fixture',
      ],
      { cwd: repoRoot },
    );
    runGit(['worktree', 'add', '--detach', worktreeRoot, 'HEAD'], { cwd: repoRoot });
    const primaryStoreRoot = deploymentAuthorizationStoreRoot(repoRoot);
    const linkedStoreRoot = deploymentAuthorizationStoreRoot(worktreeRoot);
    if (primaryStoreRoot !== linkedStoreRoot) {
      throw new Error('linked worktrees did not resolve the same authorization store');
    }

    const receiptPath = consumeDeploymentAuthorization(
      repoRoot,
      'api',
      authorizationId,
      receipt,
    );
    const stored = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (stored.authorization_id !== authorizationId || stored.state !== 'reserved_before_deploy') {
      throw new Error('stored receipt does not match the reserved authorization');
    }
    if (!isDeploymentAuthorizationConsumed(worktreeRoot, 'api', authorizationId)) {
      throw new Error('linked worktree did not observe the consumed authorization');
    }
    try {
      consumeDeploymentAuthorization(worktreeRoot, 'api', authorizationId, receipt);
    } catch (error) {
      replayRejected = error?.code === 'EEXIST';
    }
    try {
      deploymentAuthorizationReceiptPath(root, '../escape', authorizationId);
    } catch {
      unsafePathRejected = true;
    }
    if (!replayRejected || !unsafePathRejected) {
      throw new Error(
        `self-test did not bite: replay=${replayRejected} unsafe_path=${unsafePathRejected}`,
      );
    }
    console.log(
      'verify-deployment-authorization-store · PASS · shared, exclusive, replay-safe receipts',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Proves containment: run this gate as a child with GIT_DIR deliberately pointed at a
 *  disposable repo that plays "the enclosing repository", and assert that repo gained no
 *  commit and no working-tree change. Against the pre-fix gate this FAILS — the gate exits 0
 *  while HEAD advances by a `test fixture` commit and the tree goes dirty with ` D README.md`. */
function runSelfTest() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'xlooop-deploy-authorization-selftest-'));
  const enclosing = path.join(scratch, 'enclosing');
  const failures = [];
  try {
    runGit(['init', enclosing]);
    writeFileSync(path.join(enclosing, 'keep.txt'), 'enclosing repository content\n');
    runGit(['add', 'keep.txt'], { cwd: enclosing });
    runGit(
      ['-c', 'user.name=Enclosing', '-c', 'user.email=enclosing@localhost',
        'commit', '-m', 'enclosing baseline'],
      { cwd: enclosing },
    );

    const headBefore = readGit(['rev-parse', 'HEAD'], enclosing);
    const statusBefore = readGit(['status', '--porcelain'], enclosing);

    // The exact shape that caused db08f3e: GIT_DIR set, GIT_WORK_TREE unset, so git adopts
    // the child's cwd as the work tree. Start from a scrubbed base so the assertion is
    // deterministic no matter what environment invoked the self-test.
    const poisoned = { ...gitEnv(), GIT_DIR: path.join(enclosing, '.git') };
    const gate = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url)],
      { cwd: enclosing, env: poisoned, encoding: 'utf8' },
    );

    const headAfter = readGit(['rev-parse', 'HEAD'], enclosing);
    const statusAfter = readGit(['status', '--porcelain'], enclosing);

    if (gate.status !== 0) {
      failures.push(
        `gate did not pass under an inherited GIT_DIR (exit ${String(gate.status)})\n` +
        `        stderr: ${String(gate.stderr || '').trim().split('\n')[0] || '(none)'}`,
      );
    }
    if (headAfter !== headBefore) {
      const subject = readGit(['log', '-1', '--format=%h %an <%ae> %s'], enclosing);
      failures.push(
        'ENCLOSING REPOSITORY GAINED A COMMIT — the gate wrote into the repo named by GIT_DIR\n' +
        `        before : ${headBefore}\n` +
        `        after  : ${headAfter}\n` +
        `        commit : ${subject}`,
      );
    }
    if (statusAfter !== statusBefore) {
      failures.push(
        'ENCLOSING WORKING TREE CHANGED\n' +
        `        before : [${statusBefore}]\n` +
        `        after  : [${statusAfter}]`,
      );
    }

    if (failures.length > 0) {
      console.error('verify-deployment-authorization-store --self-test · FAIL');
      for (const failure of failures) console.error(`      - ${failure}`);
      console.error(
        '      the gate must never touch the repository it happens to be invoked from;\n' +
        '      every git call needs an env with the inherited GIT_* location vars deleted.',
      );
      process.exit(1);
    }
    console.log(
      'verify-deployment-authorization-store --self-test · PASS · ' +
      'gate ran green under an inherited GIT_DIR and left the enclosing repo untouched ' +
      `(HEAD ${headBefore.slice(0, 8)} unchanged, working tree clean)`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv.slice(2).includes('--self-test')) {
  runSelfTest();
} else {
  runGate();
}
