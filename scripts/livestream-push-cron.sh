#!/bin/bash
# scripts/livestream-push-cron.sh
#
# R53-W2 · launchd-driven MB-P → Workers live-stream push (hands-free freshness).
#
# Invoked by ~/Library/LaunchAgents/com.xlooop.livestream-push.plist on an
# interval. Regenerates the operations-live-stream envelope from the local MB-P
# files (real system clock → genuinely fresh timestamps) and pushes it to the
# Workers ingest endpoint so app.xlooop.com serves live governance data.
#
# Token resolution (in order):
#   1. $MBP_LIVE_STREAM_INGEST_TOKEN (if exported)
#   2. ~/.mbp/xlooop-ingest-token   (chmod 600, one line)
# If neither is present, exits non-zero (launchd logs it; nothing is pushed).
#
# Logs to ~/.mbp/logs/livestream-push.log (rotated by size in the plist's
# StandardOut/StandardError; this script just appends a timestamped header).

set -euo pipefail

# launchd gives a minimal PATH; node is installed via nvm. Resolve the newest
# nvm node bin (resilient to version bumps) + common homebrew locations.
NVM_NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="${NVM_NODE_BIN}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# R55-S0-fix (260602): was Xlooop-XCP-demo-r50 (stale sibling); now canonical repo.
# Root cause of the 22.9h stale snapshot + 91x SLA violation caught in the 260602 audit.
REPO="/Users/maratbasyrov/WIP/Xlooop/Xlooop-XCP-demo"
LOG_DIR="$HOME/.mbp/logs"
TOKEN_FILE="$HOME/.mbp/xlooop-ingest-token"

mkdir -p "$LOG_DIR"

# Resolve token
if [ -z "${MBP_LIVE_STREAM_INGEST_TOKEN:-}" ]; then
  if [ -f "$TOKEN_FILE" ]; then
    MBP_LIVE_STREAM_INGEST_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
    export MBP_LIVE_STREAM_INGEST_TOKEN
  else
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ERROR: no ingest token ($TOKEN_FILE missing and env unset)" >&2
    exit 1
  fi
fi

cd "$REPO"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] livestream-push-cron start"

TMP_ROOT="${TMPDIR:-/tmp}/xlooop-livestream-push"
mkdir -p "$TMP_ROOT"
TEMP_ENVELOPE="$TMP_ROOT/operations-live-stream-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
PUSH_FILE="data/operations-live-stream.json"
cleanup() {
  rm -f "$TEMP_ENVELOPE"
}
trap cleanup EXIT

# 1) regenerate the envelope from the local MB-P files (always canonical).
# R-J-S4-fix (260602): uses generate-operations-live-stream.mjs directly
# instead of ensure-operations-live-stream-fresh.mjs. The ensure-fresh script
# can fall back to poll:mbp-operations-live-stream (downloading the Workers KV
# cache) which may have the old source_mode value. Direct generation always
# produces source_mode: staged_snapshot (the renamed value from Wave R-J).
#
# Build-time tracked snapshots stay deterministic via buildTimestampIso(), but
# the launchd push is a runtime freshness artifact. Override BUILD_TIMESTAMP_ISO
# only for this temp envelope so the pushed DB snapshot and local push receipt
# prove the cron actually ran recently without dirtying tracked repo files.
RUNTIME_GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if BUILD_TIMESTAMP_ISO="$RUNTIME_GENERATED_AT" node scripts/generate-operations-live-stream.mjs --out="$TEMP_ENVELOPE" >/dev/null 2>&1; then
  PUSH_FILE="$TEMP_ENVELOPE"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WARN: generate failed; pushing existing envelope" >&2
fi

# 2) push to the Workers ingest endpoint
node scripts/push-operations-live-stream-to-workers.mjs --file="$PUSH_FILE"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] livestream-push-cron done"
