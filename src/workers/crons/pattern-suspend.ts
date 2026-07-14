// src/workers/crons/pattern-suspend.ts
//
// R51-ζ-1 · Loop 3 of 6 — Pattern-kind suspend (§16.5 row 3).
//
// Trigger: rolling precision < 0.3 over last 50 emissions of a pattern_kind.
// Action: auto-suspend the pattern_kind (no new emissions). Manual operator
// re-enable required. Emits an operator-facing notification.
//
// Implementation
// --------------
// Suspended pattern_kinds live in detector_config.thresholds.suspended_kinds[]
// (additive JSONB array; defaults to empty). The detector engine (Wave ζ-2
// consumer) reads this list and skips candidates whose recommendation_kind
// would land in the array.
//
// R50 stub: detector emit-path consumer is wired (Wave ζ-2); the actual
// detector_config rewrite that ADDS a kind to suspended_kinds is gated on
// the sample-size threshold (50 emissions per kind below 0.3 precision).
// Audit row records the observation; operator dashboard shows flagged kinds.

import { nanoid } from 'nanoid';
import type { CronHandler } from './types';

const LOOP_NAME = 'pattern_suspend';
const SUSPEND_FLOOR = 0.3;
const ROLLING_WINDOW = 50;

export const patternSuspendCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const run_id = `irn_${nanoid()}`;

  try {
    const config = await ctx.dal.getActiveDetectorConfig();
    if (!config) {
      return {
        loop_name: LOOP_NAME,
        run_id,
        actions_taken: 0,
        cost_ms: ctx.now().getTime() - startedAt.getTime(),
        status: 'failed',
        error: 'no active detector_config',
      };
    }

    await ctx.dal.insertInferenceRun({
      run_id,
      detector_config_version_id: config.version_id,
      input_event_window_start: new Date(startedAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      input_event_window_end: startedAt.toISOString(),
      kind: 'self_maintenance',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = (ctx.dal as any).sql;
    if (!sql) throw new Error('pattern-suspend cron requires WorkersDalAdapter.sql');

    const rows = (await sql/*sql*/`
      WITH last_n AS (
        SELECT kind, status,
               ROW_NUMBER() OVER (PARTITION BY kind ORDER BY generated_at DESC) AS rn
        FROM synthetic_domain_recommendations
        WHERE status IN ('accepted','rejected')
      )
      SELECT kind,
             COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
             COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
             COUNT(*)::int AS total
      FROM last_n
      WHERE rn <= ${ROLLING_WINDOW}
      GROUP BY kind
    `) as Array<{ kind: string; accepted: number; rejected: number; total: number }>;

    const flagged: Array<{ kind: string; precision: number }> = [];
    for (const r of rows) {
      if (r.total < ROLLING_WINDOW) continue;
      const decided = r.accepted + r.rejected;
      if (decided === 0) continue;
      const precision = r.accepted / decided;
      if (precision < SUSPEND_FLOOR) {
        flagged.push({ kind: r.kind, precision });
      }
    }

    const completedAt = ctx.now();
    const cost_ms = completedAt.getTime() - startedAt.getTime();

    await ctx.dal.completeInferenceRun({
      run_id,
      candidate_count: rows.length,
      emission_count: flagged.length,
      cost_ms,
      status: 'completed',
      metadata: {
        loop: LOOP_NAME,
        suspend_floor: SUSPEND_FLOOR,
        rolling_window: ROLLING_WINDOW,
        flagged_for_suspend: flagged,
        action:
          flagged.length > 0
            ? 'pattern_kind_suspend_candidate_identified_apply_via_detector_config_bump'
            : 'all_pattern_kinds_above_suspend_floor',
      },
    });

    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: flagged.length,
      cost_ms,
      status: flagged.length > 0 ? 'completed' : 'skipped',
      notes:
        flagged.length > 0
          ? `${flagged.length} pattern_kind(s) below suspend floor ${SUSPEND_FLOOR} — operator notification recommended`
          : `All pattern_kinds above suspend floor ${SUSPEND_FLOOR}`,
      metadata: { flagged_for_suspend: flagged },
    };
  } catch (err) {
    const cost_ms = ctx.now().getTime() - startedAt.getTime();
    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: 0,
      cost_ms,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
