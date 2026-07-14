// src/workers/crons/shadow-eval.ts
//
// R51-ζ-1 · Loop 6 of 6 — New-signal shadow-eval (§16.5 row 6).
//
// Trigger: new signal added to the taxonomy (e.g. embedding_similarity
// when it un-stubs in R51). Weight = 0 for 30 days; signal is evaluated
// and logged but contributes nothing to composite confidence. After
// 30 days of shadow data, weight enters the next loop-1 retune.
//
// Implementation
// --------------
// 1. Read active detector_config.
// 2. For each signal whose weight is 0.00 in the active config (R50:
//    embedding_similarity is the only one):
//      a. Count emissions in the 30-day window that included this signal
//         in their signal_contribution_breakdown.
//      b. If sample size ≥ 30 (one observation per day on average), mark
//         the signal as "graduation-ready" in run metadata. The next
//         weight_retune tick will pick a non-zero initial weight (handled
//         in Wave θ when retune math implements).
//      c. Otherwise log progress (sample_size / 30).
//
// R50 stub: the audit row records observations; actual graduation is gated
// on the threshold and the retune math (deferred per loop-1's deferral).

import { nanoid } from 'nanoid';
import type { CronHandler } from './types';

const LOOP_NAME = 'shadow_eval';
const SHADOW_WINDOW_DAYS = 30;
const MIN_SAMPLE_FOR_GRADUATION = 30;

export const shadowEvalCron: CronHandler = async (ctx) => {
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

    const windowMs = SHADOW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const windowStartedAt = new Date(startedAt.getTime() - windowMs).toISOString();
    await ctx.dal.insertInferenceRun({
      run_id,
      detector_config_version_id: config.version_id,
      input_event_window_start: windowStartedAt,
      input_event_window_end: startedAt.toISOString(),
      kind: 'self_maintenance',
    });

    // Identify shadow-eval signals (weight = 0 in active config).
    const shadowSignals: string[] = [];
    for (const [signal, weight] of Object.entries(config.weights)) {
      if (typeof weight === 'number' && weight === 0) {
        shadowSignals.push(signal);
      }
    }

    if (shadowSignals.length === 0) {
      const completedAt = ctx.now();
      const cost_ms = completedAt.getTime() - startedAt.getTime();
      await ctx.dal.completeInferenceRun({
        run_id,
        candidate_count: 0,
        emission_count: 0,
        cost_ms,
        status: 'completed',
        metadata: {
          loop: LOOP_NAME,
          shadow_signals: [],
          action: 'no_shadow_signals_in_active_config',
        },
      });
      return {
        loop_name: LOOP_NAME,
        run_id,
        actions_taken: 0,
        cost_ms,
        status: 'skipped',
        notes: 'No shadow-eval signals in active detector_config (all weights > 0)',
      };
    }

    // Count observations for each shadow signal via inference_signal_evals
    // (Wave γ table; bulk-written by detector engine in Wave δ-B3).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = (ctx.dal as any).sql;
    if (!sql) throw new Error('shadow-eval cron requires WorkersDalAdapter.sql');

    const counts = (await sql/*sql*/`
      SELECT signal_name, COUNT(*)::int AS observations,
             AVG(normalized_value)::numeric AS avg_normalized
      FROM inference_signal_evals
      WHERE signal_name = ANY(${shadowSignals}::text[])
        AND run_id IN (
          SELECT run_id FROM inference_runs
          WHERE started_at >= ${windowStartedAt}
        )
      GROUP BY signal_name
    `) as Array<{ signal_name: string; observations: number; avg_normalized: number }>;

    const graduationReady = counts
      .filter((c) => Number(c.observations) >= MIN_SAMPLE_FOR_GRADUATION)
      .map((c) => c.signal_name);

    const completedAt = ctx.now();
    const cost_ms = completedAt.getTime() - startedAt.getTime();

    await ctx.dal.completeInferenceRun({
      run_id,
      candidate_count: shadowSignals.length,
      emission_count: graduationReady.length,
      cost_ms,
      status: 'completed',
      metadata: {
        loop: LOOP_NAME,
        shadow_window_days: SHADOW_WINDOW_DAYS,
        min_sample_for_graduation: MIN_SAMPLE_FOR_GRADUATION,
        shadow_signals: shadowSignals,
        signal_observations: counts.map((c) => ({
          signal_name: c.signal_name,
          observations: Number(c.observations),
          avg_normalized: Number(c.avg_normalized),
        })),
        graduation_ready: graduationReady,
        action:
          graduationReady.length > 0
            ? 'shadow_signals_ready_for_weight_retune_graduation'
            : 'shadow_signals_below_graduation_threshold',
      },
    });

    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: graduationReady.length,
      cost_ms,
      status: 'completed',
      notes:
        graduationReady.length > 0
          ? `${graduationReady.length} shadow signal(s) ready for graduation: ${graduationReady.join(', ')}`
          : `${shadowSignals.length} shadow signal(s) below graduation threshold (${MIN_SAMPLE_FOR_GRADUATION} obs)`,
      metadata: { graduation_ready: graduationReady, shadow_signals: shadowSignals },
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
