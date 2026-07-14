// src/workers/crons/purge-deleted.ts
//
// F3 (260628) · customer self-service rollback PURGE. After a customer soft-deletes a roadmap/xlooop
// event (DELETE /api/v1/events/:id → archived_at set), it stays restorable for ROLLBACK_WINDOW_DAYS
// (the Profile "recently deleted" countdown). This loop is the other half: once an item is past the
// window, it is HARD-deleted so soft-deleted rows don't accumulate forever.
//
// SAFETY POSTURE (mirrors the other self-maintenance loops):
//   - FLAG-GATED, DEFAULT OFF. PURGE_DELETED_ENABLED must be exactly "true" (case-insensitive).
//     Anything else → no-op, ZERO DB writes. Deliberately SEPARATE from CUSTOMER_SELF_SERVICE_ENABLED
//     so the operator enables soft-delete/restore first (and verifies recovery) before this
//     destructive purge is ever turned on.
//   - SCOPED to source_tool='xlooop' (enforced in the DAL) — a customer-archived GOVERNANCE event is
//     NEVER hard-purged (the over-broad-purge footgun, P.8 #3).
//   - NEVER THROWS at the loop level: a DB error is isolated, counted, and returned as status:'failed'.
//
// Chained into the daily 04:00 UTC threshold_retune slot (crons/index.ts) — no new wrangler trigger.

import type { CronHandler } from './types';
import { ROLLBACK_WINDOW_DAYS } from '../lib/self-service';
import { envFlagTrue } from '../lib/env-flag';

const LOOP_NAME = 'purge_deleted';

export const purgeDeletedCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const run_id = `${LOOP_NAME}_${startedAt.toISOString()}`;

  // FLAG-GATED, DEFAULT OFF. Parsed via envFlagTrue (quote + case tolerant) so an operator who
  // sets PURGE_DELETED_ENABLED to `"true"` in the dashboard still enables it — applying the
  // Part O.4 quote-bug lesson to this new operator-set flag.
  const enabled = envFlagTrue(ctx.env?.PURGE_DELETED_ENABLED);
  if (!enabled) {
    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: 0,
      cost_ms: 0,
      status: 'skipped',
      metadata: { reason: 'PURGE_DELETED_ENABLED!=true', window_days: ROLLBACK_WINDOW_DAYS },
    };
  }

  let deleted = 0;
  let error: string | undefined;
  try {
    const r = await ctx.dal.purgeArchivedXlooopEvents(ROLLBACK_WINDOW_DAYS);
    deleted = r.deleted;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return {
    loop_name: LOOP_NAME,
    run_id,
    actions_taken: deleted,
    cost_ms: Math.max(0, ctx.now().getTime() - startedAt.getTime()),
    status: error ? 'failed' : 'completed',
    error,
    metadata: { window_days: ROLLBACK_WINDOW_DAYS, scope: "source_tool='xlooop' archived past window", deleted },
  };
};
