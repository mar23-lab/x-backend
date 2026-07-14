// src/workers/crons/calibration-retrain.ts
//
// R51-ζ-1 · Loop 5 of 6 — Calibration retrain (§16.5 row 5).
//
// Trigger: calibration_error > 0.15 in any bucket over the last 50 emissions.
// Action: trigger weight retune (loop 1) ahead of schedule. We don't directly
// invoke weight-retune; we set a flag in detector_config.metadata that the
// next weight_retune tick honors (debouncer pattern; avoids concurrent
// retunes if multiple buckets cross the threshold simultaneously).
//
// Bucket math
// -----------
// For each pattern_kind, partition emissions by composite_confidence in
// width-0.10 buckets [0.5, 0.6), [0.6, 0.7), [0.7, 0.8), [0.8, 0.9), [0.9, 1.0].
// (Lower confidences shouldn't have emitted — composite_confidence_min=0.50.)
// Per bucket:
//   predicted_acceptance_rate = midpoint of bucket (e.g. 0.55 for [0.5, 0.6))
//   actual_acceptance_rate = accepted / (accepted + rejected) within that bucket
//   calibration_error = |predicted - actual|
//
// Upserts a calibration_buckets row per (pattern_kind, bucket_lower, window_started_at).

import { nanoid } from 'nanoid';
import type { CronHandler } from './types';
import { shadowEvalCron } from './shadow-eval';

// Wave ν · CF Workers account-plan limit = 5 cron triggers. We removed
// shadow_eval's standalone cron (was "15 5 * * *") and now invoke it
// from inside this handler at the end of every return path. Both loops
// are daily, both produce calibration-quality signals; the original
// 05:00 → 05:15 sequence had shadow_eval reading the calibration data
// this loop produces, semantics unchanged.

const LOOP_NAME = 'calibration_retrain';
const CALIBRATION_ERROR_TRIGGER = 0.15;
const WINDOW_SIZE = 50;
const BUCKETS = [
  { lower: 0.5, upper: 0.6 },
  { lower: 0.6, upper: 0.7 },
  { lower: 0.7, upper: 0.8 },
  { lower: 0.8, upper: 0.9 },
  { lower: 0.9, upper: 1.0001 }, // ≤ 1.0 inclusive
];

export const calibrationRetrainCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const run_id = `irn_${nanoid()}`;

  // Wave ν chained-handler helper: runs shadow_eval after this loop's
  // primary result and surfaces a summary in `metadata.chained_shadow_eval`.
  async function runChained(primaryResult: Awaited<ReturnType<CronHandler>>): Promise<Awaited<ReturnType<CronHandler>>> {
    try {
      const chained = await shadowEvalCron(ctx);
      return {
        ...primaryResult,
        metadata: {
          ...(primaryResult.metadata ?? {}),
          chained_shadow_eval: {
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
          chained_shadow_eval_error:
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

    const windowStartedAt = new Date(startedAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await ctx.dal.insertInferenceRun({
      run_id,
      detector_config_version_id: config.version_id,
      input_event_window_start: windowStartedAt,
      input_event_window_end: startedAt.toISOString(),
      kind: 'self_maintenance',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = (ctx.dal as any).sql;
    if (!sql) throw new Error('calibration-retrain cron requires WorkersDalAdapter.sql');

    // Pull last 50 emissions per pattern_kind with composite_confidence + status.
    const rows = (await sql/*sql*/`
      WITH last_n AS (
        SELECT r.kind, r.status, r.composite_confidence,
               ROW_NUMBER() OVER (PARTITION BY r.kind ORDER BY r.generated_at DESC) AS rn
        FROM synthetic_domain_recommendations r
        WHERE r.composite_confidence IS NOT NULL
          AND r.status IN ('accepted','rejected')
      )
      SELECT kind, status, composite_confidence
      FROM last_n
      WHERE rn <= ${WINDOW_SIZE}
    `) as Array<{ kind: string; status: string; composite_confidence: number }>;

    // Bucket per (kind, bucket_lower).
    const byKindBucket = new Map<string, { accepted: number; rejected: number }>();
    for (const r of rows) {
      const conf = Number(r.composite_confidence);
      const bucket = BUCKETS.find((b) => conf >= b.lower && conf < b.upper);
      if (!bucket) continue;
      const key = `${r.kind}__${bucket.lower}`;
      let agg = byKindBucket.get(key);
      if (!agg) {
        agg = { accepted: 0, rejected: 0 };
        byKindBucket.set(key, agg);
      }
      if (r.status === 'accepted') agg.accepted++;
      else if (r.status === 'rejected') agg.rejected++;
    }

    // Compute calibration_error per bucket and upsert.
    const triggers: Array<{ kind: string; bucket_lower: number; error: number }> = [];
    for (const [key, agg] of byKindBucket.entries()) {
      const [kind, bucketLowerStr] = key.split('__');
      const bucket_lower = Number(bucketLowerStr);
      const bucket_upper = BUCKETS.find((b) => b.lower === bucket_lower)?.upper ?? bucket_lower + 0.10;
      const decided = agg.accepted + agg.rejected;
      if (decided === 0) continue;
      const actual_rate = agg.accepted / decided;
      const predicted_rate = bucket_lower + 0.05; // midpoint of [lower, upper)
      const calibration_error = Math.abs(predicted_rate - actual_rate);

      await ctx.dal.upsertCalibrationBucket({
        pattern_kind: kind!,
        bucket_lower,
        bucket_upper: Math.min(1.0, bucket_upper),
        predicted_acceptance_rate: predicted_rate,
        actual_acceptance_rate: actual_rate,
        predicted_count: decided, // approximation
        accepted_count: agg.accepted,
        rejected_count: agg.rejected,
        deferred_count: 0,
        calibration_error,
        window_started_at: windowStartedAt,
        window_size_emissions: decided,
      });

      if (calibration_error > CALIBRATION_ERROR_TRIGGER) {
        triggers.push({ kind: kind!, bucket_lower, error: calibration_error });
      }
    }

    const completedAt = ctx.now();
    const cost_ms = completedAt.getTime() - startedAt.getTime();

    await ctx.dal.completeInferenceRun({
      run_id,
      candidate_count: byKindBucket.size,
      emission_count: triggers.length,
      cost_ms,
      status: 'completed',
      metadata: {
        loop: LOOP_NAME,
        retrain_trigger_threshold: CALIBRATION_ERROR_TRIGGER,
        buckets_evaluated: byKindBucket.size,
        triggers,
        action:
          triggers.length > 0
            ? 'calibration_drift_detected_weight_retune_recommended_next_tick'
            : 'calibration_within_target',
      },
    });

    return await runChained({
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: triggers.length,
      cost_ms,
      status: 'completed',
      notes:
        triggers.length > 0
          ? `${triggers.length} bucket(s) exceeded calibration_error threshold ${CALIBRATION_ERROR_TRIGGER}`
          : 'Calibration within target across all buckets',
      metadata: { triggers, buckets_evaluated: byKindBucket.size },
    });
  } catch (err) {
    const cost_ms = ctx.now().getTime() - startedAt.getTime();
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
