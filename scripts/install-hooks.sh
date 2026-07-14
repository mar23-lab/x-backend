#!/bin/sh
# Phase T3-A · install canonical git hooks for this clone.
# Round 14 R14.1 (2026-05-20) · also installs pre-push hook for
# local-gate-only CI policy.
#
# Run once after `git clone` or whenever the canonical hook sources
# change. Idempotent — safe to re-run; just overwrites the installed
# hooks.
#
# Usage:
#   ./scripts/install-hooks.sh
#
# Installs:
#   - .git/hooks/pre-commit  ← scripts/pre-commit.sh           (Phase T3-A)
#   - .git/hooks/pre-push    ← scripts/git-hooks/pre-push      (R14.1)

set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"

# S2 (260709) · worktree-safe hooks dir: in a linked worktree `.git` is a FILE (gitdir pointer), so
# `$REPO_ROOT/.git/hooks` is not a directory. `--git-path hooks` resolves to the shared main-repo
# hooks dir in every checkout shape.
HOOKS_DIR="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOKS_DIR"

# pre-commit hook
PRE_COMMIT_SRC="$REPO_ROOT/scripts/pre-commit.sh"
PRE_COMMIT_DST="$HOOKS_DIR/pre-commit"

if [ ! -f "$PRE_COMMIT_SRC" ]; then
  echo "✗ canonical pre-commit not found at $PRE_COMMIT_SRC" >&2
  exit 1
fi

cp "$PRE_COMMIT_SRC" "$PRE_COMMIT_DST"
chmod +x "$PRE_COMMIT_DST"
echo "✓ installed pre-commit hook ($PRE_COMMIT_DST)"
echo "  bypass with: git commit --no-verify  (logs a learning per docs/learnings.md)"

# pre-push hook (R14.1)
PRE_PUSH_SRC="$REPO_ROOT/scripts/git-hooks/pre-push"
PRE_PUSH_DST="$HOOKS_DIR/pre-push"

if [ ! -f "$PRE_PUSH_SRC" ]; then
  echo "✗ canonical pre-push not found at $PRE_PUSH_SRC" >&2
  exit 1
fi

cp "$PRE_PUSH_SRC" "$PRE_PUSH_DST"
chmod +x "$PRE_PUSH_DST"
echo "✓ installed pre-push hook ($PRE_PUSH_DST)"
echo "  runs \`npm run ci-local\` before every push (6 local gates)"
echo "  bypass with: git push --no-verify  (operator-explicit only)"
