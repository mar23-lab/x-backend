// src/workers/crons/threshold-retune.ts
//
// R51-ζ-1 · Loop 2 of 6 — Threshold retune (§16.5 row 2).
//
// Trigger: rolling precision < 0.5 over last 50 emissions of a pattern_kind.
// Action: raise E_min for that pattern_kind by 0.5. If precision recovers
// above 0.7 for 30 consecutive days, lower back (sticky-up, recovery-down).
//
// R50 stub policy
// ---------------
// The `synthetic_domain_recommendations.kind` column carries the pattern_kind
// (e.g. 'add_goal', 'extend_timeline'). We compute rolling precision per kind:
//   precision = accepted / (accepted + rejected)
// over the last 50 emissions of that kind.
//
// Threshold mutation is per-pattern-kind, not global. We store the per-kind
// E_min overrides in detector_config.thresholds.E_min_per_kind (additive
// JSONB field; defaults to global E_min when absent).
//
// In R50 we ship the cadence + audit; the actual threshold-bump is gated on
// sample size ≥ 50 emissions per kind. Below that → status='skipped'.

import { nanoid } from 'nanoid';
import type { CronHandler } from './types';
import { patternSuspendCron } from './pattern-suspend';

const LOOP_NAME = 'threshold_retune';
const PRECISION_FLOOR = 0.5;
const ROLLING_WINDOW = 50;

// Wave ν · CF Workers account-plan limit = 5 cron triggers. We removed
// pattern_suspend's standalone cron (was "30 4 * * *") and now invoke it
// from inside this handler at the end of the success path. Both loops are
// daily, both target precision-based decisions, and pattern_suspend
// observed the fresh data threshold_retune produced anyway in the original
// 04:00 → 04:30 sequence — semantics unchanged.

export const thresholdRetuneCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const run_id = `irn_${nanoid()}`;

  // Helper: invoke the chained pattern_suspend at the very end of any
  // return-path so the precision audit happens daily even though only one
  // cron is registered. Result is logged but does NOT override this
  // handler's own return value (visibility preserved via metadata.chained).
  async function runChained(primaryResult: Awaited<ReturnType<CronHandler>>): Promise<Awaited<ReturnType<CronHandler>>> {
    try {
      const chained = await patternSuspendCron(ctx);
      return {
        ...primaryResult,
        metadata: {
          ...(primaryResult.metadata ?? {}),
          chained_pattern_suspend: {
            status: chained.status,
            actions_taken: chained.actions_taken,
            run_id: chained.run_id,
            notes: chained.notes,
          },
        },
      };
    } catch (chainedErr) {
      return {
        ...primaryResult,
        metadata: {
          ...(primaryResult.metadata ?? {}),
          chained_pattern_suspend_error:
            chainedErr instanceof Error ? chainedErr.message : String(chainedErr),
        },
      };
    }
  }

  try {
    const config = await ctx.dal.getActiveDetectorConfig();
    if (!config) {
      return await runChained({
        loop_name: LOOP_NAME,
        run_id,
        actions_taken: 0,
        cost_ms: ctx.now().getTime() - startedAt.getTime(),
        status: 'failed',
        error: 'no active detector_config',
      });
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
    if (!sql) {
      throw new Error('threshold-retune cron requires WorkersDalAdapter.sql');
    }

    // Compute precision per pattern_kind over last 50 emissions of that kind.
    // status: 'accepted' / 'rejected' / 'pending' / 'expired' / 'superseded'.
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

    const flagged: Array<{ kind: string; precision: number; total: number }> = [];
    for (const r of rows) {
      if (r.total < ROLLING_WINDOW) continue; // need full window for a verdict
      const decided = r.accepted + r.rejected;
      if (decided === 0) continue;
      const precision = r.accepted / decided;
      if (precision < PRECISION_FLOOR) {
        flagged.push({ kind: r.kind, precision, total: r.total });
      }
    }

    // R50 stub: identifying the bump candidate; actual config rewrite lands
    // when a kind crosses the floor with full sample. Audit row records the
    // observation regardless.
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
        precision_floor: PRECISION_FLOOR,
        rolling_window: ROLLING_WINDOW,
        observed: rows,
        flagged_for_retune: flagged,
        action:
          flagged.length > 0
            ? 'threshold_bump_candidate_identified_apply_deferred_to_weight_retune_pipeline'
            : 'all_pattern_kinds_above_precision_floor',
      },
    });

    return await runChained({
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: flagged.length,
      cost_ms,
      status: flagged.length > 0 ? 'completed' : 'skipped',
      notes:
        flagged.length > 0
          ? `${flagged.length} pattern_kind(s) below precision floor ${PRECISION_FLOOR}`
          : `All pattern_kinds above precision floor ${PRECISION_FLOOR}`,
      metadata: { flagged_for_retune: flagged },
    });
  } catch (err) {
    const cost_ms = ctx.now().getTime() - startedAt.getTime();
    // Even on threshold_retune failure, attempt pattern_suspend — it has
    // its own independent failure handling.
    return await runChained({
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: 0,
      cost_ms,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
