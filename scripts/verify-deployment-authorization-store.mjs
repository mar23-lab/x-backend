#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  consumeDeploymentAuthorization,
  deploymentAuthorizationStoreRoot,
  deploymentAuthorizationReceiptPath,
  isDeploymentAuthorizationConsumed,
} from './lib/deployment-authorization-store.mjs';

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
  execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
  writeFileSync(path.join(repoRoot, 'README.md'), 'deployment authorization test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync(
    'git',
    [
      '-c', 'user.name=Xlooop verifier',
      '-c', 'user.email=verifier@localhost',
      'commit', '-m', 'test fixture',
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  execFileSync(
    'git',
    ['worktree', 'add', '--detach', worktreeRoot, 'HEAD'],
    { cwd: repoRoot, stdio: 'ignore' },
  );
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
