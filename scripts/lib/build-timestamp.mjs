// scripts/lib/build-timestamp.mjs · deterministic build timestamp (F5 fix, 2026-06-05 retro).
//
// Generated/tracked artifacts (operations-live-stream.json, document-context-read-model.json,
// REPO-SCHEMA.*) previously baked `new Date()` / `Date.now()` into their output, so every
// build dirtied them with a fresh wall-clock value -> a perpetual false-dirty working tree
// (~5 manual reverts in the 260605 session). This helper returns a STABLE timestamp derived
// from the git HEAD commit time, so a no-op rebuild is byte-identical (idempotent) while the
// value still updates meaningfully when the source actually changes (a new commit).
//
// Override order: BUILD_TIMESTAMP_ISO > SOURCE_DATE_EPOCH > git HEAD commit time > epoch.
import { execFileSync } from 'node:child_process';

let cached = null;

export function buildTimestampIso() {
  if (cached) return cached;
  if (process.env.BUILD_TIMESTAMP_ISO) {
    cached = new Date(process.env.BUILD_TIMESTAMP_ISO).toISOString();
    return cached;
  }
  if (process.env.SOURCE_DATE_EPOCH) {
    cached = new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
    return cached;
  }
  try {
    const iso = execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], { encoding: 'utf8' }).trim();
    if (iso) {
      cached = new Date(iso).toISOString();
      return cached;
    }
  } catch {
    /* fall through to deterministic epoch fallback - never wall-clock */
  }
  cached = new Date(0).toISOString();
  return cached;
}

// Compact YYYYMMDDHHMMSS form (e.g. for ids) derived from the same stable timestamp.
export function buildStampCompact() {
  return buildTimestampIso().replace(/[-:T]/g, '').slice(0, 14);
}
