// src/workers/crons/propagation-tick.ts
//
// R51-ζ-1 · Loop 0 (existing) — Propagation tick (R49' PR-5+6).
//
// Wraps the existing dal.runPropagationTick('system-cron') call in the
// CronHandler contract so the dispatcher can route it alongside the 5
// new self-maintenance loops. Behavior is unchanged from src/workers/index.ts
// pre-Wave-ζ.

import type { CronHandler } from './types';

const LOOP_NAME = 'propagation_tick';

export const propagationTickCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  try {
    // The DAL method writes its own audit row (propagation_tick_state)
    // and returns a PropagationTickResult. We surface it to the registry
    // result for telemetry.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await (ctx.dal as any).runPropagationTick('system-cron')) as {
      ticks_run: number;
      events_seen: number;
      recommendations_generated: number;
      expired_count: number;
      last_event_ts: string | null;
      duration_ms: number;
      error?: string;
    };
    const cost_ms = ctx.now().getTime() - startedAt.getTime();
    return {
      loop_name: LOOP_NAME,
      run_id: `propagation_tick_${result.last_event_ts ?? 'noop'}`,
      actions_taken: result.recommendations_generated,
      cost_ms,
      status: result.error ? 'failed' : 'completed',
      notes: result.error ?? `${result.events_seen} events seen, ${result.recommendations_generated} recs generated, ${result.expired_count} expired`,
      error: result.error,
      metadata: {
        loop: LOOP_NAME,
        events_seen: result.events_seen,
        recommendations_generated: result.recommendations_generated,
        expired_count: result.expired_count,
        last_event_ts: result.last_event_ts,
        duration_ms: result.duration_ms,
      },
    };
  } catch (err) {
    const cost_ms = ctx.now().getTime() - startedAt.getTime();
    return {
      loop_name: LOOP_NAME,
      run_id: 'propagation_tick_err',
      actions_taken: 0,
      cost_ms,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
