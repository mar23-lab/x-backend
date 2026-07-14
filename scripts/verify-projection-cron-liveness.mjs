#!/usr/bin/env node
// scripts/verify-projection-cron-liveness.mjs · projection-freshness-deblock follow-up (2026-06-11)
//
// WHY THIS EXISTS: PR #598 de-blocked MB-P projection FRESHNESS from the
// pre-push integrity gate (a lapsed 24h lease must not red-light an unrelated
// push). That correctly removed the recurring daily blocker, but it also
// removed the only AUTOMATIC signal that the staged projection had gone stale —
// so a genuinely DEAD producer cron (io.mbp.xlooop-projection-cron) or a long-
// neglected consumer staging step could ship a very stale projection into the
// demo/tenant bundle with no visible warning (the residual risk flagged in the
// PR #598 adversarial review).
//
// This is the NON-BLOCKING (WARN-tier) backstop that review asked for. It is
// deliberately COARSE and LONG-thresholded so it does NOT fire on a routine
// daily lease lapse (now expected + tolerated) — only when the staged
// projection's generated_at is old enough to indicate the producer cron is dead
// OR staging has been neglected for multiple cycles.
//
// CONTRACT: this MUST stay WARN-tier in ci-local. Re-blocking here would
// re-create the exact daily-oscillation blocker PR #598 removed. STRICT,
// fail-closed freshness stays owned by verify:mbp-projection-freshness on the
// commercial/demo path (verify-commercial-demo-readiness.mjs).
//
// Exit: 0 = fresh-enough (within liveness threshold); 1 = STALE (surfaced as a
// non-blocking warn in ci-local). Threshold configurable (hours):
//   VERIFY_PROJECTION_LIVENESS_MAX_AGE_HOURS=72 node scripts/verify-projection-cron-liveness.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTION_PATH = path.join(REPO_ROOT, 'data', 'mbp-operations-projection.json');
const SCHEMA = 'xlooop.projection_cron_liveness.v1';

// Default 48h = two daily producer cycles. The lease is 24h; routine de-blocked
// operation (staged a cycle or two ago with a healthy upstream cron) stays under
// this. Crossing it means ~2+ missed cycles → cron likely dead or staging
// neglected — worth a visible (non-blocking) warning on every push.
const MAX_AGE_HOURS = Number(process.env.VERIFY_PROJECTION_LIVENESS_MAX_AGE_HOURS || '48');
const MAX_AGE_MS = MAX_AGE_HOURS * 3600 * 1000;

console.log('verify-projection-cron-liveness · WARN-tier staleness advisory');
console.log(`  threshold: ${MAX_AGE_HOURS}h (producer cron io.mbp.xlooop-projection-cron)`);

function warnStale(message, extra = {}) {
  console.warn(JSON.stringify({ status: 'WARN_STALE', schema_version: SCHEMA, message, ...extra }, null, 2));
  // Non-zero so the ci-local 'warn' tier surfaces it loudly; never blocking.
  process.exit(1);
}
function pass(extra = {}) {
  console.log(JSON.stringify({ status: 'PASS', schema_version: SCHEMA, max_age_hours: MAX_AGE_HOURS, ...extra }, null, 2));
  process.exit(0);
}

if (!existsSync(PROJECTION_PATH)) {
  warnStale('staged MB-P projection missing — producer cron may be dead OR staging never run', {
    expected: 'data/mbp-operations-projection.json',
    renewal_command: 'npm run ensure:mbp-projection-fresh',
  });
}

let projection;
try {
  projection = JSON.parse(readFileSync(PROJECTION_PATH, 'utf8'));
} catch (err) {
  warnStale('staged MB-P projection is not parseable JSON', { error: String((err && err.message) || err) });
}

const generatedAt = projection.generated_at || null;
const generatedMs = Date.parse(generatedAt || '');
if (!Number.isFinite(generatedMs)) {
  warnStale('staged MB-P projection has no parseable generated_at', { generated_at: generatedAt });
}

const ageHours = Number(((Date.now() - generatedMs) / 3.6e6).toFixed(1));
// 260710-F · valid_until surfaced in BOTH payloads (visibility, not new detection — with the fixed
// 24h lease, the 48h generated_at threshold already equals "one fully missed renewal past expiry").
// A raw expiry check is deliberately NOT added: the lease lapses daily by design (PR #598 CONTRACT).
const validUntil = typeof projection.valid_until === 'string' ? projection.valid_until : null;
const validUntilExpired = validUntil ? Date.parse(validUntil) < Date.now() : null;

if ((Date.now() - generatedMs) > MAX_AGE_MS) {
  warnStale(
    `staged MB-P projection generated_at is ${ageHours}h old (> ${MAX_AGE_HOURS}h liveness threshold) — `
    + 'producer cron io.mbp.xlooop-projection-cron may be dead OR consumer staging neglected. '
    + 'Non-blocking (projection freshness was de-blocked from the push gate in PR #598); '
    + 'strict freshness is owned by verify:mbp-projection-freshness on the commercial/demo path.',
    {
      generated_at: generatedAt,
      age_hours: ageHours,
      max_age_hours: MAX_AGE_HOURS,
      valid_until: validUntil,
      valid_until_expired: validUntilExpired,
      projection_id: projection.projection_id || null,
      renewal_command: 'npm run ensure:mbp-projection-fresh',
      structural_fix: 'H1 live rail (scripts/push-mbp-projection-to-workers.mjs + MBP_PROJECTION_LIVE_RAIL_ENABLED) removes the repo-commit dependency entirely',
    },
  );
}

pass({ generated_at: generatedAt, age_hours: ageHours, valid_until: validUntil, valid_until_expired: validUntilExpired, projection_id: projection.projection_id || null });
