// src/workers/crons/weight-retune.ts
//
// R51-ζ-1 · Loop 1 of 6 — Weight retune (§16.5 row 1).
//
// Trigger: every 50 operator accept/reject actions OR weekly, whichever first.
// Cron expression: weekly fallback at @weekly. The 50-action-threshold path
// is event-driven and lives in the accept/reject route handlers (deferred
// to Wave θ; cron fallback ships first).
//
// Action
// ------
// 1. Read the active detector_config.
// 2. Survey the last N=50 inference_emissions (or window since previous
//    weight_retune run, whichever larger).
// 3. For each emission: did the operator accept or reject? (Status on the
//    referenced synthetic_domain_recommendations row.)
// 4. Compute new weights via simple weighted-average update:
//      new_weight[signal] = α · old_weight + (1−α) · average_contribution_among_accepted
//    where α = 0.7 (heavily damped to avoid runaway tuning).
// 5. If new weights differ from old by > 0.01 in any signal → emit new
//    detector_config row + deactivate previous.
//
// R50 stub policy
// ---------------
// Real logistic-regression retune lands when sufficient accept/reject data
// accumulates (operator floor: 50 decisions). Until then, this loop logs
// the candidate sample size + skips with `status='skipped'`. The audit row
// still gets written so the cadence is visible in the dashboard.

import { nanoid } from 'nanoid';
import { envFlagTrue } from '../lib/env-flag';
import type { CronHandler, CronHandlerContext, CronHandlerResult } from './types';
import { runScheduledDigestSweep, type SweepResult } from '../services/scheduled-digest-sweep';

const LOOP_NAME = 'weight_retune';
const MIN_ACTIONS_FOR_RETUNE = 50;

/**
 * Chain the SELF-DRIVING digest sweep onto this weekly loop (same cadence: Mon 03:00 UTC), mirroring
 * how calibration_retrain chains shadow_eval. Folds the sweep result into the primary result's
 * metadata and adds its `drafted` count to actions_taken. The sweep is flag-gated (default OFF) and
 * never throws — so it can only ADD a governed proposal count, never break weight_retune.
 */
async function chainDigestSweep(
  ctx: CronHandlerContext,
  primary: CronHandlerResult,
): Promise<CronHandlerResult> {
  // Flag: default OFF. Only the exact string "true" (case-insensitive) activates the sweep.
  const flagEnabled = envFlagTrue(ctx.env?.DIGEST_SWEEP_ENABLED);
  // Operator identity set — same derivation as routes/workspaces.ts:33-34 (owner + linked, trimmed).
  const ownerUserIds = [
    ctx.env?.MBP_OWNER_USER_ID,
    ...String(ctx.env?.MBP_OWNER_LINKED_USER_IDS || '').split(','),
  ]
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  const sweep: SweepResult = await runScheduledDigestSweep({
    dal: ctx.dal,
    ai: ctx.env?.AI,
    ownerUserIds,
    flagEnabled,
    now: ctx.now,
  });

  return {
    ...primary,
    actions_taken: primary.actions_taken + sweep.drafted,
    metadata: {
      ...(primary.metadata ?? {}),
      digest_sweep: sweep,
    },
  };
}

export const weightRetuneCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const run_id = `irn_${nanoid()}`;

  try {
    const config = await ctx.dal.getActiveDetectorConfig();
    if (!config) {
      return await chainDigestSweep(ctx, {
        loop_name: LOOP_NAME,
        run_id,
        actions_taken: 0,
        cost_ms: ctx.now().getTime() - startedAt.getTime(),
        status: 'failed',
        error: 'no active detector_config (run migration 010 genesis seed)',
      });
    }

    // Open a self-maintenance audit row.
    await ctx.dal.insertInferenceRun({
      run_id,
      detector_config_version_id: config.version_id,
      input_event_window_start: new Date(startedAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      input_event_window_end: startedAt.toISOString(),
      kind: 'self_maintenance',
    });

    // R50 stub: actual logistic-regression retune is deferred.
    // We still write the audit row so the operator dashboard reflects
    // that the loop fired. Sample size will accumulate in production.
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
        retune_threshold: MIN_ACTIONS_FOR_RETUNE,
        action: 'cadence_observed_retune_deferred',
        note:
          'Weight retune stubbed in R50; real logistic-regression update lands when ' +
          'operator accumulates ≥ 50 accept/reject decisions. This run is audit-only.',
      },
    });

    return await chainDigestSweep(ctx, {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: 0,
      cost_ms,
      status: 'skipped',
      notes: 'R50 stub · cadence audited, retune deferred',
    });
  } catch (err) {
    const cost_ms = ctx.now().getTime() - startedAt.getTime();
    return await chainDigestSweep(ctx, {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: 0,
      cost_ms,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
