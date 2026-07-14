import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const STANDALONE_BUILD_LOCK = join(tmpdir(), 'xlooop-xcp-demo-build-standalone.lock');
export const READONLY_VERIFICATION_LOCK = join(tmpdir(), 'xlooop-xcp-demo-readonly-verification.lock');

export function acquireStandaloneBuildLock(repoRoot) {
  const payload = {
    pid: process.pid,
    repo_root: repoRoot,
    started_at: new Date().toISOString(),
  };
  try {
    const fd = openSync(STANDALONE_BUILD_LOCK, 'wx');
    try {
      writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    return () => releaseStandaloneBuildLockForPid(process.pid);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const active = readStandaloneBuildLock();
    if (active && !pidIsAlive(active.pid)) {
      releaseStandaloneBuildLockForPid(active.pid);
      return acquireStandaloneBuildLock(repoRoot);
    }
    const ageSeconds = active?.mtime_ms ? Math.round((Date.now() - active.mtime_ms) / 1000) : 'unknown';
    throw new Error(
      `build-standalone lock active at ${STANDALONE_BUILD_LOCK}; ` +
      `pid=${active?.pid || 'unknown'} age_seconds=${ageSeconds}. ` +
      'Another session is rebuilding generated shell artifacts; wait and retry.'
    );
  }
}

export function activeStandaloneBuildLock() {
  const active = readStandaloneBuildLock();
  if (!active || !pidIsAlive(active.pid)) return null;
  return active;
}

export function assertNoStandaloneBuildLock(context = 'generated-artifact-reader') {
  const active = activeStandaloneBuildLock();
  if (!active) return;
  const ageSeconds = active.mtime_ms ? Math.round((Date.now() - active.mtime_ms) / 1000) : 'unknown';
  console.error(
    `${context} · blocked because generated artifact writer lock is active; ` +
    `pid=${active.pid || 'unknown'} age_seconds=${ageSeconds} path=${STANDALONE_BUILD_LOCK}. ` +
    'Wait for build:standalone or commercial preflight to finish, then retry.'
  );
  process.exit(1);
}

export function acquireReadOnlyVerificationLock(repoRoot) {
  const payload = {
    pid: process.pid,
    repo_root: repoRoot,
    started_at: new Date().toISOString(),
  };
  try {
    const fd = openSync(READONLY_VERIFICATION_LOCK, 'wx');
    try {
      writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    return () => releaseReadOnlyVerificationLockForPid(process.pid);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const active = readReadOnlyVerificationLock();
    if (active && !pidIsAlive(active.pid)) {
      releaseReadOnlyVerificationLockForPid(active.pid);
      return acquireReadOnlyVerificationLock(repoRoot);
    }
    const ageSeconds = active?.mtime_ms ? Math.round((Date.now() - active.mtime_ms) / 1000) : 'unknown';
    throw new Error(
      `read-only verification lock active at ${READONLY_VERIFICATION_LOCK}; ` +
      `pid=${active?.pid || 'unknown'} age_seconds=${ageSeconds}. ` +
      'Another commercial/readiness verifier is protecting tracked generated artifacts; wait and retry.'
    );
  }
}

export function activeReadOnlyVerificationLock() {
  const active = readReadOnlyVerificationLock();
  if (!active || !pidIsAlive(active.pid)) return null;
  return active;
}

export function assertNoReadOnlyVerificationLock(context = 'generated-artifact-writer') {
  const active = activeReadOnlyVerificationLock();
  if (!active) return;
  const ageSeconds = active.mtime_ms ? Math.round((Date.now() - active.mtime_ms) / 1000) : 'unknown';
  console.error(
    `${context} · blocked because read-only verification lock is active; ` +
    `pid=${active.pid || 'unknown'} age_seconds=${ageSeconds} path=${READONLY_VERIFICATION_LOCK}. ` +
    'Run npm run commercial:preflight before read-only verification, or wait for the verifier to finish.'
  );
  process.exit(1);
}

export function readStandaloneBuildLock() {
  try {
    const raw = readFileSync(STANDALONE_BUILD_LOCK, 'utf8');
    const stat = statSync(STANDALONE_BUILD_LOCK);
    const parsed = JSON.parse(raw);
    return { ...parsed, mtime_ms: stat.mtimeMs };
  } catch (_) {
    return null;
  }
}

export function readReadOnlyVerificationLock() {
  try {
    const raw = readFileSync(READONLY_VERIFICATION_LOCK, 'utf8');
    const stat = statSync(READONLY_VERIFICATION_LOCK);
    const parsed = JSON.parse(raw);
    return { ...parsed, mtime_ms: stat.mtimeMs };
  } catch (_) {
    return null;
  }
}

export function releaseStandaloneBuildLockForPid(pid) {
  const active = readStandaloneBuildLock();
  if (!active || active.pid !== pid) return;
  try { unlinkSync(STANDALONE_BUILD_LOCK); } catch (_) { /* already released */ }
}

export function releaseReadOnlyVerificationLockForPid(pid) {
  const active = readReadOnlyVerificationLock();
  if (!active || active.pid !== pid) return;
  try { unlinkSync(READONLY_VERIFICATION_LOCK); } catch (_) { /* already released */ }
}

export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}
