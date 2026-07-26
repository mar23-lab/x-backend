import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,119}$/i;

function assertSegment(value, name) {
  if (!SAFE_SEGMENT.test(String(value || ''))) {
    throw new Error(`${name} must be a safe filesystem segment`);
  }
}

export function deploymentAuthorizationStoreRoot(repoRoot) {
  const commonDir = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  if (!path.isAbsolute(commonDir)) {
    throw new Error('git common directory must resolve to an absolute path');
  }
  return path.join(commonDir, 'xlooop-deployment-authorizations');
}

export function deploymentAuthorizationReceiptPath(storeRoot, surface, authorizationId) {
  assertSegment(surface, 'surface');
  assertSegment(authorizationId, 'authorization_id');
  return path.join(storeRoot, surface, `${authorizationId}.json`);
}

export function isDeploymentAuthorizationConsumed(
  repoRoot,
  surface,
  authorizationId,
) {
  return existsSync(
    deploymentAuthorizationReceiptPath(
      deploymentAuthorizationStoreRoot(repoRoot),
      surface,
      authorizationId,
    ),
  );
}

export function consumeDeploymentAuthorizationAt(
  storeRoot,
  surface,
  authorizationId,
  receipt,
) {
  const receiptPath = deploymentAuthorizationReceiptPath(storeRoot, surface, authorizationId);
  mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  const fd = openSync(receiptPath, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
  return receiptPath;
}

export function consumeDeploymentAuthorization(
  repoRoot,
  surface,
  authorizationId,
  receipt,
) {
  return consumeDeploymentAuthorizationAt(
    deploymentAuthorizationStoreRoot(repoRoot),
    surface,
    authorizationId,
    receipt,
  );
}
