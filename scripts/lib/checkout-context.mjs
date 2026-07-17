// scripts/lib/checkout-context.mjs
//
// "Is this checkout able to see machine-local (gitignored) inputs?"
//
// WHY THIS EXISTS
// `git worktree add` does NOT copy gitignored files — they live only in the primary checkout.
// The production deploy receipt (docs/deployment/evidence/latest-*-deploy-receipt.json, ignored at
// .gitignore:79) is exactly such an input. A generator that reads its absence as "no deploy receipt
// exists" turns a LOOKUP FAILURE into a health verdict — and, because the generator's output is a
// COMMITTED file carrying a production verdict, an agent working in a worktree (the standard pattern
// for parallel sessions here) can push a fabricated "operator_gated" regression.
//
// Measured 260717: running build-production-readiness-state.mjs from
// _wt/codex-commercial-completion-20260715/backend flipped verdict "go" -> "operator_gated" and added
// drift flag "no deploy receipt at ...". The receipt was present and valid in the primary the whole
// time (source_commit a01aa8a930d838af872e4928761f35e7beacf71c). The committed "go" was correct.
//
// This is the estate's recurring shape: a gate must report what it did NOT scan — empty scope is a
// lookup failure, not health. (MB-P _sys/xcp-system/evidence/260717_G_bind_the_blocker_rule.md.)
//
// The discriminator is exact, and verified in both directions:
//   linked worktree -> --absolute-git-dir (…/.git/worktrees/<name>) !== --git-common-dir (…/.git)
//   primary         -> the two are IDENTICAL, so callers are never falsely flagged.

import path from 'node:path';
import { execSync } from 'node:child_process';

function safeGit(args, cwd) {
  try {
    return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

/** Absolute path of the SHARED git dir, or null outside a repo.
 *  `--git-common-dir` may return a RELATIVE path (git resolves it against cwd) — resolving it is
 *  load-bearing, not defensive: the same handling exists in scripts/cwd-anchor.mjs:109. */
export function gitCommonDir(cwd) {
  const raw = safeGit('rev-parse --git-common-dir', cwd);
  if (!raw) return null;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
}

/** True when `cwd` is inside a LINKED worktree (so gitignored inputs are not present here).
 *  Fails CLOSED to `false`: if git cannot answer, we do not claim a worktree and callers keep their
 *  existing behaviour rather than refusing on a guess. */
export function isLinkedWorktree(cwd) {
  const gitDir = safeGit('rev-parse --absolute-git-dir', cwd);
  const commonDir = gitCommonDir(cwd);
  if (!gitDir || !commonDir) return false;
  return path.resolve(gitDir) !== commonDir;
}

/** Best-effort path of the PRIMARY working tree — the checkout that DOES hold gitignored inputs.
 *  Returned for the operator message only; nothing reads across checkouts. Null for a bare repo. */
export function primaryWorktreePath(cwd) {
  const commonDir = gitCommonDir(cwd);
  if (!commonDir || path.basename(commonDir) !== '.git') return null;
  return path.dirname(commonDir);
}

/** Refuse (exit non-zero) rather than emit a verdict derived from an input this checkout cannot see.
 *  Refusing beats emitting a placeholder verdict: a written file can be committed over a correct one;
 *  a refusal cannot. Callers pass the gitignored input's repo-relative path for the message. */
export function refuseIfInputUnavailableHere({ cwd, inputRelPath, what }) {
  if (!isLinkedWorktree(cwd)) return; // primary: absence is a real finding — caller keeps its behaviour
  const primary = primaryWorktreePath(cwd);
  console.error([
    `REFUSING to write ${what}: required input is not available in THIS checkout.`,
    ``,
    `  missing here : ${inputRelPath}`,
    `  reason       : this is a LINKED WORKTREE, and the file is gitignored (.gitignore:79).`,
    `                 git worktree add never copies gitignored files.`,
    `  NOT a finding: its absence here says nothing about whether a deploy receipt exists.`,
    primary ? `  run instead in: ${primary}` : `  run instead in: the primary checkout`,
    ``,
    `Emitting a verdict from here would fabricate a production regression. Refusing instead.`,
  ].join('\n'));
  process.exit(2);
}
