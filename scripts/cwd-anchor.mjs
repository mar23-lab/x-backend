#!/usr/bin/env node
// scripts/cwd-anchor.mjs · Phase 8 P8.14 · cwd anchor verifier
//
// Reads .xlooop-root from the canonical repo root and compares the
// `canonical_path` value to process.cwd(). Exits non-zero with a loud
// message if they disagree.
//
// Pre-commit invokes this before any other gate. Verify skill §0 runs
// it as the first check before cold-load. Smoke-cli (P8.15) checks for
// its existence.
//
// Closes the dual-folder defect class (D3 / L38).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ANCHOR_FILE = path.join(REPO_ROOT, '.xlooop-root');

function fail(msg, expected) {
  console.error('');
  console.error('  ✗ cwd-anchor mismatch');
  console.error('  ' + msg);
  if (expected) console.error('  expected canonical_path: ' + expected);
  console.error('  actual cwd:              ' + process.cwd());
  console.error('  actual repo root:        ' + REPO_ROOT);
  console.error('');
  console.error('  This guard prevents the dual-folder defect (D3/L38).');
  console.error('  If you intend a path migration, update .xlooop-root first.');
  console.error('');
  process.exit(1);
}

if (!fs.existsSync(ANCHOR_FILE)) {
  fail('.xlooop-root file is missing at ' + ANCHOR_FILE);
}

const raw = fs.readFileSync(ANCHOR_FILE, 'utf8');
const m = raw.match(/^canonical_path\s*=\s*(.+)$/m);
if (!m) {
  fail('.xlooop-root does not contain a `canonical_path = ...` line');
}
const expected = m[1].trim();

// GitHub Actions checks out the repository under /home/runner/work/..., so the
// operator-machine absolute path can never match there. Keep the local guard
// strict, but allow CI to prove the repo by remote identity + checkout shape.
const isCi = process.env.XLOOP_CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
if (isCi) {
  const remoteMatch = raw.match(/^canonical_remote\s*=\s*(.+)$/m);
  const expectedRemote = remoteMatch ? remoteMatch[1].trim() : null;
  const actualRemote = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}.git`
    : null;
  if (expectedRemote && actualRemote && expectedRemote !== actualRemote) {
    fail(
      `CI remote mismatch: expected ${expectedRemote}, actual ${actualRemote}.`,
      expected,
    );
  }
  console.log(`cwd-anchor · ✓ CI checkout ${REPO_ROOT} for ${expected}`);
  process.exit(0);
}

if (REPO_ROOT !== expected && isLinkedCanonicalWorktree(expected)) {
  console.log(`cwd-anchor · ✓ linked worktree ${REPO_ROOT} backed by ${expected} (agent-agnostic)`);
  process.exit(0);
}

if (REPO_ROOT !== expected) {
  fail(
    'Repo root resolved from this script does not match the anchor file.',
    expected,
  );
}

// Optional strict mode: also check process.cwd().
// Disabled by default because pre-commit runs from .git, smoke-cli runs
// from the repo root, etc. The repo-root match above is the load-bearing
// check; cwd is informational.
const strict = process.argv.includes('--strict-cwd');
if (strict && process.cwd() !== expected) {
  fail(
    '--strict-cwd: process.cwd() does not match canonical_path.',
    expected,
  );
}

console.log('cwd-anchor · ✓ ' + expected);
process.exit(0);

function isLinkedCanonicalWorktree(expectedRoot) {
  // Agent-agnostic (MB-P HR-PARALLEL-WRITER-ISOLATION-1 / L-260608): accept commits from
  // ANY linked git worktree whose shared git-common-dir resolves to the canonical repo's
  // .git — regardless of which runtime (claude/codex/cursor/openclaw/hermes) or a human
  // created the branch. The `commonDir === canonical/.git` match IS the load-bearing
  // dual-folder (D3/L38) guard: a stale duplicate CLONE has its own .git and stays blocked;
  // a linked worktree shares the canonical .git and is the right repo. Lets parallel sessions
  // of ANY runtime isolate in their own worktree instead of serialising on the single
  // canonical checkout. (Superseded the codex/claude-only prefix gate, which was not
  // runtime-neutral and forced non-prefixed branches back onto the shared checkout — the
  // exact friction HR-PARALLEL-WRITER-ISOLATION-1 codifies.)
  const commonDirRaw = safeGit(['rev-parse', '--git-common-dir']);
  if (!commonDirRaw) return false;

  const commonDir = path.isAbsolute(commonDirRaw)
    ? path.resolve(commonDirRaw)
    : path.resolve(REPO_ROOT, commonDirRaw);
  const canonicalGitDir = path.resolve(expectedRoot, '.git');

  return commonDir === canonicalGitDir;
}

function safeGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
