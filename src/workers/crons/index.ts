// src/workers/crons/index.ts
//
// R51-ζ-1 · Cron registry + dispatcher.
//
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16.5 (six
// self-maintenance loops) + wrangler.toml [triggers] crons array.
//
// Cron expressions chosen to balance Cloudflare free-tier latency
// (5min minimum) with §16.4.2 operating defaults:
//
//   Loop 0 (propagation_tick)      · existing R49' PR-5+6     · @5min  · "*/5 * * * *"
//   Loop 1 (weight_retune)         · §16.5 row 1 · weekly      · @weekly · "0 3 * * 1"   (Mon 03:00 UTC)
//   Loop 2 (threshold_retune)      · §16.5 row 2 · daily       · @daily  · "0 4 * * *"   (Daily 04:00 UTC)
//   Loop 3 (pattern_suspend)       · §16.5 row 3 · daily       · @daily  · "30 4 * * *"  (Daily 04:30 UTC)
//   Loop 4 (permanent_suppress)    · §16.5 row 4 · hourly      · @hourly · "0 * * * *"
//   Loop 5 (calibration_retrain)   · §16.5 row 5 · daily       · @daily  · "0 5 * * *"   (Daily 05:00 UTC)
//   Loop 6 (shadow_eval)           · §16.5 row 6 · daily       · @daily  · "15 5 * * *"  (Daily 05:15 UTC)
//   Backstop (reclassify_unattributed) · PR #517 self-heal     · @hourly · "45 * * * *"  (hourly :45 · flag-gated, default OFF)
//
// Why these specific times: keep self-maintenance loops in a low-traffic
// window (03:00–05:30 UTC = 14:00–16:30 AEST = 23:00–01:30 EDT) so they
// don't compete with operator-driven detector ticks during peak hours.
// Calibration + shadow-eval run AFTER threshold_retune + pattern_suspend
// so they see fresh data from those upstream loops.

import { propagationTickCron } from './propagation-tick';
import { weightRetuneCron } from './weight-retune';
import { thresholdRetuneCron } from './threshold-retune';
import { purgeDeletedCron } from './purge-deleted';
import { patternSuspendCron } from './pattern-suspend';
import { permanentSuppressCron } from './permanent-suppress';
import { calibrationRetrainCron } from './calibration-retrain';
import { shadowEvalCron } from './shadow-eval';
import { reviewScheduleCron } from './review-schedule';
import { reclassifyUnattributedCron } from './reclassify-unattributed';
import { graphRebuildCron } from './graph-rebuild';
import { tenantProjectionDispatchCron } from './tenant-projection-dispatch';
import { runOperationsQueueConsumer, type QueueConsumerResult } from '../services/operations-queue-consumer';
import type { CronHandler, CronHandlerResult, CronRegistryEntry } from './types';

export type { CronHandler, CronHandlerContext, CronHandlerResult, CronRegistryEntry } from './types';
export { propagationTickCron } from './propagation-tick';
export { weightRetuneCron } from './weight-retune';
export { thresholdRetuneCron } from './threshold-retune';
export { patternSuspendCron } from './pattern-suspend';
export { permanentSuppressCron } from './permanent-suppress';
export { calibrationRetrainCron } from './calibration-retrain';
export { shadowEvalCron } from './shadow-eval';
export { reclassifyUnattributedCron } from './reclassify-unattributed';
export { graphRebuildCron } from './graph-rebuild';
export { tenantProjectionDispatchCron } from './tenant-projection-dispatch';

// Commercial single-intake projection dispatch shares the existing five-minute trigger. Both loops
// execute independently; the projection lane is default-off and cannot degrade propagation while inert.
const propagationThenTenantProjection: CronHandler = async (ctx) => {
  let primary: CronHandlerResult | null = null;
  let primaryError: string | null = null;
  try { primary = await propagationTickCron(ctx); }
  catch (error) { primaryError = error instanceof Error ? error.message : String(error); }
  let projection: CronHandlerResult | null = null;
  let projectionError: string | null = null;
  try { projection = await tenantProjectionDispatchCron(ctx); }
  catch (error) { projectionError = error instanceof Error ? error.message : String(error); }
  const base = primary ?? {
    loop_name: 'propagation_tick+tenant_projection_dispatch',
    run_id: `composite_${ctx.now().toISOString()}`,
    actions_taken: 0,
    cost_ms: 0,
    status: 'failed' as const,
    error: primaryError ?? undefined,
  };
  const projectionFailed = projection?.status === 'failed' || projection?.status === 'degraded' || Boolean(projectionError);
  return {
    ...base,
    status: base.status === 'failed' ? 'failed' : projectionFailed ? 'degraded' : base.status,
    actions_taken: base.actions_taken + (projection?.actions_taken ?? 0),
    metadata: {
      ...(base.metadata ?? {}),
      propagation_error: primaryError,
      tenant_projection_dispatch: projection ? { status: projection.status, actions_taken: projection.actions_taken, ...(projection.metadata ?? {}) } : null,
      tenant_projection_dispatch_error: projectionError,
    },
  };
};

// ARCH-004 Phase A: the 5-cron wrangler limit + single-handler-per-expression dispatch means new loops
// CHAIN into an existing slot (the established pattern — "chaining pairs of daily loops"). The hourly
// `0 * * * *` slot runs permanent_suppress THEN the graph rebuild (best-effort; the rebuild never aborts
// the suppress loop). Both handlers stay pure + independently unit-testable; they compose here.
const permanentSuppressThenGraphRebuild: CronHandler = async (ctx) => {
  // Run BOTH loops INDEPENDENTLY — neither aborts the other (ARCH-005 X.6 fix: previously a throw in
  // permanent_suppress would skip the graph_rebuild entirely; the rebuild feeds the discoverability
  // substrate and is the more important of the two, so it MUST run regardless).
  let a: CronHandlerResult | null = null;
  let suppressErr: string | null = null;
  try { a = await permanentSuppressCron(ctx); } catch (e) { suppressErr = e instanceof Error ? e.message : String(e); }
  let graphMeta: Record<string, unknown> | null = null;
  let graphNotes: string | null = null;
  let graphFailed = false;
  try {
    const b = await graphRebuildCron(ctx);
    graphMeta = b.metadata ?? null; graphNotes = b.notes ?? null;
    graphFailed = b.status === 'failed' || b.status === 'degraded'; // OBS-1: propagate the secondary status
  }
  catch (e) { graphNotes = `graph_rebuild error: ${e instanceof Error ? e.message : String(e)}`; graphFailed = true; }
  const base: CronHandlerResult = a ?? {
    loop_name: 'permanent_suppress+graph_rebuild', run_id: `composite_${ctx.now().toISOString()}`,
    actions_taken: 0, cost_ms: 0, status: 'failed', error: suppressErr ?? undefined,
  };
  // OBS-1 (J-W3): a failed SECONDARY loop no longer hides behind a 'completed' primary — escalate to
  // 'degraded' (which decideCronReport now reports) unless the composite already 'failed'.
  const status = base.status === 'failed' ? 'failed' : (graphFailed ? 'degraded' : base.status);
  return { ...base, status, metadata: { ...(base.metadata ?? {}), permanent_suppress_error: suppressErr, graph_rebuild: graphMeta, graph_rebuild_notes: graphNotes } };
};

// OS-3 UX Wave-2.1: the execution-pipeline executor (operations-queue-consumer) CHAINS into the
// hourly reclassify_unattributed slot (45 * * * *) — both are hourly, flag-gated, default-OFF
// self-heal/queue backstops, so they are natural siblings. Same independent-composite shape as
// permanentSuppressThenGraphRebuild: reclassify runs first, the queue-drain second, and NEITHER
// aborts the other (a throw in reclassify still lets the executor drain, and vice-versa). The
// executor is gated on EXECUTOR_MODE === 'enabled' (default OFF) and never throws, so it can only
// ADD a governed proposal count, never break the reclassify backstop. The cron is the GUARANTEED-
// EVENTUALLY backstop; Wave 2.2's enqueue route may also drain inline for responsiveness.
const reclassifyThenDrainQueue: CronHandler = async (ctx) => {
  let primary: CronHandlerResult | null = null;
  let reclassifyErr: string | null = null;
  try { primary = await reclassifyUnattributedCron(ctx); }
  catch (e) { reclassifyErr = e instanceof Error ? e.message : String(e); }

  // EXECUTOR_MODE: only the exact string "enabled" (case-insensitive) activates the drain.
  const executorEnabled = String(ctx.env?.EXECUTOR_MODE || '').toLowerCase() === 'enabled';
  // Operator identity set — same derivation as routes/workspaces.ts + the digest sweep (owner + linked).
  const ownerUserIds = [
    ctx.env?.MBP_OWNER_USER_ID,
    ...String(ctx.env?.MBP_OWNER_LINKED_USER_IDS || '').split(','),
  ]
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  let drain: QueueConsumerResult | null = null;
  let drainErr: string | null = null;
  try {
    drain = await runOperationsQueueConsumer({ dal: ctx.dal, ai: ctx.env?.AI, ownerUserIds, executorEnabled, now: ctx.now });
  } catch (e) { drainErr = e instanceof Error ? e.message : String(e); }

  const base: CronHandlerResult = primary ?? {
    loop_name: 'reclassify_unattributed',
    run_id: `composite_${ctx.now().toISOString()}`,
    actions_taken: 0,
    cost_ms: 0,
    status: 'failed',
    error: reclassifyErr ?? undefined,
  };
  // OBS-1 (J-W3): a failed ops-queue drain (secondary) escalates the composite to 'degraded'.
  const status = base.status === 'failed' ? 'failed' : (drainErr ? 'degraded' : base.status);
  return {
    ...base,
    status,
    actions_taken: base.actions_taken + (drain?.executed ?? 0),
    metadata: {
      ...(base.metadata ?? {}),
      reclassify_error: reclassifyErr,
      ops_queue_drain: drain,
      ops_queue_drain_error: drainErr,
    },
  };
};

// F3 (260628) · the customer self-service rollback PURGE chains into the daily 04:00 UTC
// threshold_retune slot (a low-traffic window; daily is the right cadence for a 30-day retention
// sweep). Same independent-composite shape as the others: threshold_retune runs first, the purge
// second, and NEITHER aborts the other. The purge is flag-gated (PURGE_DELETED_ENABLED, default OFF)
// and scoped to source_tool='xlooop', so it is inert + safe until explicitly enabled.
const thresholdRetuneThenPurge: CronHandler = async (ctx) => {
  let primary: CronHandlerResult | null = null;
  let retuneErr: string | null = null;
  try { primary = await thresholdRetuneCron(ctx); } catch (e) { retuneErr = e instanceof Error ? e.message : String(e); }
  let purgeMeta: Record<string, unknown> | null = null;
  let purgeErr: string | null = null;
  let purgeFailed = false;
  try { const p = await purgeDeletedCron(ctx); purgeMeta = { status: p.status, deleted: p.actions_taken, ...(p.metadata ?? {}) }; purgeFailed = p.status === 'failed' || p.status === 'degraded'; }
  catch (e) { purgeErr = e instanceof Error ? e.message : String(e); purgeFailed = true; }
  const base: CronHandlerResult = primary ?? {
    loop_name: 'threshold_retune+purge_deleted', run_id: `composite_${ctx.now().toISOString()}`,
    actions_taken: 0, cost_ms: 0, status: 'failed', error: retuneErr ?? undefined,
  };
  // OBS-1 (J-W3): a failed purge (secondary) escalates the composite to 'degraded'.
  const status = base.status === 'failed' ? 'failed' : (purgeFailed ? 'degraded' : base.status);
  return { ...base, status, metadata: { ...(base.metadata ?? {}), threshold_retune_error: retuneErr, purge_deleted: purgeMeta, purge_deleted_error: purgeErr } };
};

// A10 (260713) · the review-cadence loop CHAINS into the daily 05:00 UTC calibration_retrain slot (a
// low-traffic window; daily is the right cadence to surface due goal-reviews). Same independent-composite
// shape as thresholdRetuneThenPurge: calibration runs first, the review-scheduler second, and NEITHER
// aborts the other. The review loop is flag-gated (REVIEW_SCHEDULER_ENABLED, default OFF) and performs
// ZERO DB IO when off, so it is inert + safe until explicitly enabled.
const calibrationRetrainThenReviewSchedule: CronHandler = async (ctx) => {
  let primary: CronHandlerResult | null = null;
  let calibErr: string | null = null;
  try { primary = await calibrationRetrainCron(ctx); } catch (e) { calibErr = e instanceof Error ? e.message : String(e); }
  let reviewMeta: Record<string, unknown> | null = null;
  let reviewErr: string | null = null;
  let reviewFailed = false;
  try {
    const r = await reviewScheduleCron(ctx);
    reviewMeta = { status: r.status, emitted: r.actions_taken, ...(r.metadata ?? {}) };
    reviewFailed = r.status === 'failed' || r.status === 'degraded';
  }
  catch (e) { reviewErr = e instanceof Error ? e.message : String(e); reviewFailed = true; }
  const base: CronHandlerResult = primary ?? {
    loop_name: 'calibration_retrain+review_schedule', run_id: `composite_${ctx.now().toISOString()}`,
    actions_taken: 0, cost_ms: 0, status: 'failed', error: calibErr ?? undefined,
  };
  // OBS-1 (J-W3): a failed review-scheduler (secondary) escalates the composite to 'degraded'.
  const status = base.status === 'failed' ? 'failed' : (reviewFailed ? 'degraded' : base.status);
  return { ...base, status, metadata: { ...(base.metadata ?? {}), calibration_retrain_error: calibErr, review_schedule: reviewMeta, review_schedule_error: reviewErr } };
};

/**
 * Registry of cron triggers keyed by their wrangler.toml cron expression.
 * The scheduledHandler in src/workers/index.ts dispatches event.cron →
 * registry lookup → handler.
 */
export const CRON_REGISTRY: ReadonlyArray<CronRegistryEntry> = Object.freeze([
  {
    cron: '*/5 * * * *',
    loop_name: 'propagation_tick+tenant_projection_dispatch',
    handler: propagationThenTenantProjection,
    description: 'R49 propagation worker + default-off tenant projection outbox dispatcher · 5-minute tick',
  },
  {
    cron: '0 * * * *',
    loop_name: 'permanent_suppress+graph_rebuild',
    handler: permanentSuppressThenGraphRebuild,
    description: '§16.5 loop 4 (permanent_suppress) + ARCH-004 Phase A graph_rebuild chained · hourly · rebuilds the operator data-graph (drift-aware, idempotent)',
  },
  {
    cron: '0 4 * * *',
    loop_name: 'threshold_retune',
    handler: thresholdRetuneThenPurge,
    description: '§16.5 loop 2 · raise E_min per pattern_kind when precision < 0.5. CHAINED (F3 260628): customer self-service rollback purge · hard-deletes source_tool=xlooop events archived past the 30-day window · flag-gated PURGE_DELETED_ENABLED (default OFF)',
  },
  {
    cron: '30 4 * * *',
    loop_name: 'pattern_suspend',
    handler: patternSuspendCron,
    description: '§16.5 loop 3 · auto-suspend pattern_kind when precision < 0.3',
  },
  {
    cron: '0 5 * * *',
    loop_name: 'calibration_retrain',
    handler: calibrationRetrainThenReviewSchedule,
    description: '§16.5 loop 5 · per-bucket calibration_error → trigger weight retune. CHAINED (A10 260713): review-scheduler surfaces due goal-reviews (needs_review events) + bumps review_due · flag-gated REVIEW_SCHEDULER_ENABLED (default OFF)',
  },
  {
    cron: '15 5 * * *',
    loop_name: 'shadow_eval',
    handler: shadowEvalCron,
    description: '§16.5 loop 6 · 30-day shadow window for weight=0 signals',
  },
  {
    cron: '0 3 * * 1',
    loop_name: 'weight_retune',
    handler: weightRetuneCron,
    description: '§16.5 loop 1 · weekly weight retune fallback',
  },
  {
    cron: '45 * * * *',
    loop_name: 'reclassify_unattributed',
    handler: reclassifyThenDrainQueue,
    description:
      'Self-healing backstop (PR #517) · hourly · re-file unattributed events into the 8 bodies-of-work projects · flag-gated RECLASSIFY_CRON_ENABLED (default OFF). CHAINED: OS-3 UX Wave-2.1 ops-queue executor drains queued operation_events into governed proposals · flag-gated EXECUTOR_MODE (default OFF)',
  },
]);

/**
 * O(1) lookup. Frozen at module load.
 */
export const CRON_BY_EXPRESSION: Readonly<Record<string, CronRegistryEntry>> = Object.freeze(
  CRON_REGISTRY.reduce<Record<string, CronRegistryEntry>>((acc, entry) => {
    acc[entry.cron] = entry;
    return acc;
  }, {}),
);

export const CRON_BY_LOOP_NAME: Readonly<Record<string, CronRegistryEntry>> = Object.freeze(
  CRON_REGISTRY.reduce<Record<string, CronRegistryEntry>>((acc, entry) => {
    acc[entry.loop_name] = entry;
    return acc;
  }, {}),
);
