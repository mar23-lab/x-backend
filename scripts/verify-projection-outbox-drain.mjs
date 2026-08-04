#!/usr/bin/env node
/**
 * verify-projection-outbox-drain — ITEM 23 of the 260803 plan, closed as a DEPLOY-TIME gate.
 *
 * THE FINDING (measured, and my own audit overstated it first). C2 claimed the outbox was
 * "unbounded, monotonic, billed". Queried against production it was **4 rows, 80 kB, static for 7
 * days** — latent, not live. But the STRUCTURAL half is real and unchanged:
 *
 *   - 10 DAL modules run `INSERT INTO projection_outbox` UNCONDITIONALLY.
 *   - `TENANT_PROJECTION_QUEUE_ENABLED` gates only the DRAIN
 *     (crons/tenant-projection-dispatch.ts), never the writes.
 *   - So the table fills with no consumer BY CONSTRUCTION. It simply is not filling yet, because the
 *     operations that fill it barely run at current traffic.
 *
 * It becomes real the moment the pilot has users — which is exactly when nobody will be looking.
 *
 * WHY THIS LIVES IN `deploy:api` AND NOT `ci-local`. The check needs a live DATABASE_URL, and
 * ci-local has none. A gate that cannot run is a gate that reports nothing, and this estate has
 * already retired three controls for exactly that. I originally declined to build it at all on those
 * grounds — that was wrong: the right home was always the deploy chain, where credentials exist and
 * where the check fires at the moment it matters.
 *
 * WHAT IT ASSERTS. Undispatched depth against a threshold, and — the part that makes it more than a
 * size alarm — WHETHER A DRAIN IS ENABLED AT ALL. A growing queue with no consumer is a different
 * defect from a growing queue with a slow consumer, and the message says which.
 *
 *   XLOOOP_PROJECTION_OUTBOX_MAX_UNDISPATCHED   default 1000
 *   TENANT_PROJECTION_QUEUE_ENABLED             read to classify the finding
 *
 * Run:  node scripts/verify-projection-outbox-drain.mjs            (needs DATABASE_URL)
 *       node scripts/verify-projection-outbox-drain.mjs --self-test (no DB; proves the logic)
 */

import { neon } from '@neondatabase/serverless';

const selfTest = process.argv.includes('--self-test');
const MAX_UNDISPATCHED = Number(process.env.XLOOOP_PROJECTION_OUTBOX_MAX_UNDISPATCHED || 1000);

/**
 * Pure decision function — the whole verdict, so it can be exercised without a database.
 * Returns { ok, severity, message }.
 */
export function assessOutbox({ undispatched, total, oldestIso, drainEnabled, max }) {
  if (undispatched > max) {
    return {
      ok: false,
      severity: drainEnabled ? 'drain_too_slow' : 'no_consumer',
      message: drainEnabled
        ? `projection_outbox has ${undispatched} undispatched rows (> ${max}) WITH the drain enabled — the consumer is not keeping up.`
        : `projection_outbox has ${undispatched} undispatched rows (> ${max}) and TENANT_PROJECTION_QUEUE_ENABLED is OFF — 10 DAL modules write this table unconditionally and NOTHING drains it. Bind the queue or delete the write sites; do not ship more writes into a table with no consumer.`,
    };
  }
  if (undispatched > 0 && !drainEnabled) {
    return {
      ok: true,
      severity: 'latent_no_consumer',
      message: `projection_outbox holds ${undispatched} undispatched row(s) (total ${total}, oldest ${oldestIso || 'n/a'}) and the drain is DISABLED. Below the ${max} threshold, so not blocking — but this is write-amplification with no consumer, and it becomes real the moment traffic arrives.`,
    };
  }
  return {
    ok: true,
    severity: 'ok',
    message: `projection_outbox undispatched=${undispatched} (total ${total}), drain ${drainEnabled ? 'ENABLED' : 'disabled'} — within the ${max} threshold.`,
  };
}

function runSelfTest() {
  const controls = [
    [assessOutbox({ undispatched: 5000, total: 5000, drainEnabled: false, max: 1000 }).ok, false, 'over threshold with NO drain BLOCKS'],
    [assessOutbox({ undispatched: 5000, total: 5000, drainEnabled: false, max: 1000 }).severity, 'no_consumer', 'over threshold with no drain is classified no_consumer'],
    [assessOutbox({ undispatched: 5000, total: 5000, drainEnabled: true, max: 1000 }).severity, 'drain_too_slow', 'over threshold WITH a drain is a DIFFERENT finding'],
    [assessOutbox({ undispatched: 4, total: 4, drainEnabled: false, max: 1000 }).ok, true, 'the MEASURED production state (4 rows) does not block'],
    [assessOutbox({ undispatched: 4, total: 4, drainEnabled: false, max: 1000 }).severity, 'latent_no_consumer', 'but 4 rows with no drain is still NAMED as latent, not silently green'],
    [assessOutbox({ undispatched: 0, total: 12, drainEnabled: true, max: 1000 }).severity, 'ok', 'a drained queue is plain ok'],
    [assessOutbox({ undispatched: 1000, total: 1000, drainEnabled: false, max: 1000 }).ok, true, 'the threshold is exclusive — exactly at the limit does not block'],
    [assessOutbox({ undispatched: 1001, total: 1001, drainEnabled: false, max: 1000 }).ok, false, 'one over the limit DOES block'],
  ];
  const passed = controls.filter(([actual, expected]) => actual === expected).length;
  for (const [actual, expected, label] of controls) {
    console.log(`  ${actual === expected ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (passed !== controls.length) {
    console.error(`verify-projection-outbox-drain self-test FAIL — ${passed} of ${controls.length} controls held`);
    process.exit(1);
  }
  console.log(`verify-projection-outbox-drain self-test PASS — ${passed} of ${controls.length} controls held`);
  process.exit(0);
}

if (selfTest) runSelfTest();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  // FAIL-CLOSED, and say what would have been measured. A skip that prints "PASS" is the exact
  // defect this estate retired verify:coverage-claim for.
  console.error(
    'verify-projection-outbox-drain · FAIL-CLOSED · DATABASE_URL is required.\n'
    + '  This gate measures the LIVE undispatched depth of projection_outbox; without the DSN it\n'
    + '  asserts NOTHING and must not report success. It runs inside deploy:api, where the DSN exists.',
  );
  process.exit(1);
}

const sql = neon(databaseUrl);
const rows = await sql`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE status = 'pending')::int AS undispatched,
         min(created_at) FILTER (WHERE status = 'pending') AS oldest
    FROM public.projection_outbox
`;
const { total = 0, undispatched = 0, oldest = null } = rows[0] || {};
const drainEnabled = /^(1|true|yes|on)$/i.test(String(process.env.TENANT_PROJECTION_QUEUE_ENABLED || ''));

const verdict = assessOutbox({
  undispatched,
  total,
  oldestIso: oldest ? new Date(oldest).toISOString() : null,
  drainEnabled,
  max: MAX_UNDISPATCHED,
});

if (!verdict.ok) {
  console.error(`verify-projection-outbox-drain · FAIL [${verdict.severity}] · ${verdict.message}`);
  process.exit(1);
}
console.log(`verify-projection-outbox-drain · PASS [${verdict.severity}] · ${verdict.message}`);
