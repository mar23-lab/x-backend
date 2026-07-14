// src/workers/crons/permanent-suppress.ts
//
// R51-ζ-1 · Loop 4 of 6 — Cooldown extend / permanent suppress (§16.5 row 4).
//
// Trigger: 3× operator rejection of the same `pattern_fingerprint` →
// elevate to permanent_suppress_fingerprint. Loop runs hourly to consume
// the recommendation_rejections table and write back the suppress flag.
//
// Action
// ------
// 1. SELECT pattern_fingerprint_at_reject, COUNT(*) FROM recommendation_rejections
//      WHERE permanent_suppress_fingerprint IS NULL
//      GROUP BY pattern_fingerprint_at_reject HAVING COUNT(*) >= 3.
// 2. For each candidate fingerprint, UPDATE recommendation_rejections
//      SET permanent_suppress_fingerprint = pattern_fingerprint_at_reject
//      WHERE pattern_fingerprint_at_reject = $1.
// 3. Detector engine (Wave ζ-2 consumer) reads this set before emitting
//    and skips candidates whose pattern_fingerprint hashes to a suppressed
//    value.
//
// The threshold (3) comes from detector_config.thresholds.permanent_suppress_threshold
// (R50 default; mutable in later waves via Wave ζ-1 weight_retune).

import { nanoid } from 'nanoid';
import type { CronHandler } from './types';

const LOOP_NAME = 'permanent_suppress';

export const permanentSuppressCron: CronHandler = async (ctx) => {
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
    const threshold = Number(config.thresholds.permanent_suppress_threshold ?? 3);

    await ctx.dal.insertInferenceRun({
      run_id,
      detector_config_version_id: config.version_id,
      input_event_window_start: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      input_event_window_end: startedAt.toISOString(),
      kind: 'self_maintenance',
    });

    // Direct SQL because the DAL doesn't yet expose a list-aggregated-by-
    // fingerprint method. Reach the sql client via the WorkersDalAdapter cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = (ctx.dal as any).sql;
    if (!sql) {
      throw new Error('permanent-suppress cron requires WorkersDalAdapter.sql client');
    }

    // Step 1 + 2 in a single CTE so the update is atomic.
    const updated = (await sql/*sql*/`
      WITH candidates AS (
        SELECT pattern_fingerprint_at_reject AS fp
        FROM recommendation_rejections
        WHERE permanent_suppress_fingerprint IS NULL
        GROUP BY pattern_fingerprint_at_reject
        HAVING COUNT(*) >= ${threshold}
      )
      UPDATE recommendation_rejections rr
      SET permanent_suppress_fingerprint = rr.pattern_fingerprint_at_reject
      WHERE rr.pattern_fingerprint_at_reject IN (SELECT fp FROM candidates)
        AND rr.permanent_suppress_fingerprint IS NULL
      RETURNING rr.id, rr.pattern_fingerprint_at_reject
    `) as Array<{ id: number; pattern_fingerprint_at_reject: string }>;

    const distinctFingerprints = new Set(updated.map((r) => r.pattern_fingerprint_at_reject));
    const completedAt = ctx.now();
    const cost_ms = completedAt.getTime() - startedAt.getTime();

    await ctx.dal.completeInferenceRun({
      run_id,
      candidate_count: distinctFingerprints.size,
      emission_count: updated.length,
      cost_ms,
      status: 'completed',
      metadata: {
        loop: LOOP_NAME,
        threshold,
        suppressed_fingerprints: [...distinctFingerprints],
      },
    });

    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: updated.length,
      cost_ms,
      status: 'completed',
      notes:
        distinctFingerprints.size > 0
          ? `Suppressed ${distinctFingerprints.size} fingerprint(s) (${updated.length} row(s) updated)`
          : 'No fingerprints crossed the suppress threshold this tick',
      metadata: {
        suppressed_fingerprints: [...distinctFingerprints],
        threshold,
      },
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
