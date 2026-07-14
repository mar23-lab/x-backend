// src/workers/crons/review-schedule.ts
//
// Stage-2 A10 · review-cadence cron — turns the SE-1 review_cadence/review_due columns (mig 069) into
// a recurring governance rhythm. MB-P's operating rhythm IS its review cadence (weekly domain
// closeouts, monthly finance/career reviews, quarterly re-evaluation); this is the tenant-facing
// counterpart that makes governance OPERATE rather than merely exist (PROD plan Tier-A gap A10).
//
// PER RUN (mirrors reclassify-unattributed.ts structure + safety):
//   1. FLAG GATE — REVIEW_SCHEDULER_ENABLED must be exactly "true" (case-insensitive). Anything else →
//      no-op with ZERO DB reads/writes (the byte-identical-off guarantee).
//   2. Read the bounded, cross-workspace backlog of ACTIVE goals whose review_due has passed
//      (dal.listGoalsWithReviewDue) and pass them to the pure kernel (services/review-scheduler.ts
//      selectDueReviews) which orders most-overdue-first + computes overdue_days.
//   3. Per due goal, BEST-EFFORT (never throws at batch level):
//        (a) surface a `needs_review` operation_event in the events rail / needs-you queue, with a
//            DETERMINISTIC id per (goal, review_due) so a re-run BEFORE the bump is an idempotent no-op
//            (dal.upsertEvent is insert-if-absent);
//        (b) advance review_due to the next cadence slot (rescheduleReviewDue → dal.updateGoalReviewDue);
//            event-only cadences (no keyword) return null and are surfaced-but-not-rescheduled.
//   4. Return a structured CronHandlerResult the dispatcher logs + Sentry-reports (degraded on partial).

import type { CronHandler, CronHandlerContext, CronHandlerResult } from './types';
import { envFlagTrue } from '../lib/env-flag';
import { selectDueReviews, rescheduleReviewDue, type GoalReviewRow } from '../services/review-scheduler';

const LOOP_NAME = 'review_schedule';
/** The instrument id stamped on emitted needs_review events (a SYSTEM actor, not a human).
 *  Registered in docs/contracts/agent-roles.yml (OAR-W0 F5 fix — the original 'agent_review_scheduler'
 *  string was an unregistered identity the parity gate's narrow scan missed). */
const REVIEW_AGENT_ID = 'xlooop:review-scheduler';
/** Bounded batch per run so a large backlog drains over several runs without a long query. */
export const MAX_BATCH = 500;

/** The minimal event-write surface on the DAL (upsertEvent already exists — not a new method). The
 *  goal-review reads/writes come via ctx.reviewSchedule (a gateway bound from the store functions in the
 *  dispatcher), NOT the frozen WorkersDalAdapter facade. */
type ReviewDal = Pick<CronHandlerContext['dal'], 'upsertEvent'>;

export const reviewScheduleCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const run_id = `review_schedule_${startedAt.toISOString()}`;

  // ── SAFE-BY-DEFAULT: flag must be exactly "true" (case-insensitive) ──────────
  if (!envFlagTrue(ctx.env?.REVIEW_SCHEDULER_ENABLED)) {
    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: 0,
      cost_ms: ctx.now().getTime() - startedAt.getTime(),
      status: 'skipped',
      notes: 'flag_disabled · set REVIEW_SCHEDULER_ENABLED=true to enable',
      metadata: { loop: LOOP_NAME, reason: 'flag_disabled' },
    };
  }

  const gw = ctx.reviewSchedule;
  if (!gw) {
    // Gateway not injected (should never happen in the real dispatcher) — fail loud in telemetry, never throw.
    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: 0,
      cost_ms: ctx.now().getTime() - startedAt.getTime(),
      status: 'failed',
      error: 'review-schedule gateway not injected into cron context',
      metadata: { loop: LOOP_NAME, reason: 'gateway_absent' },
    };
  }

  const dal = ctx.dal as ReviewDal;
  const now = ctx.now();
  const nowDateIso = now.toISOString().slice(0, 10);
  let scanned = 0;
  let emitted = 0;
  let rescheduled = 0;
  let errors = 0;

  try {
    const rows = await gw.listDue(nowDateIso, MAX_BATCH);
    scanned = rows.length;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const due = selectDueReviews(rows as unknown as GoalReviewRow[], now); // most-overdue first + overdue_days

    for (const d of due) {
      try {
        const row = byId.get(d.goal_id);
        if (!row) continue;
        // (a) surface a needs_review row — deterministic id ⇒ idempotent on re-run before the bump.
        await dal.upsertEvent(row.workspace_id, {
          id: `evt_review_${d.goal_id}_${d.review_due}`,
          source_tool: 'xlooop',
          agent_id: REVIEW_AGENT_ID,
          status: 'needs_review',
          approval_state: 'pending',
          visibility: 'internal_workspace',
          domain_id: row.domain_id ?? null,
          summary: `Goal review due (${d.overdue_days}d overdue) · cadence ${d.cadence ?? 'n/a'}`,
          body: `Goal ${d.goal_id} in domain ${row.domain_id ?? 'n/a'} reached its review_due (${d.review_due}). Re-evaluate against its SMART-ER metrics.`,
          occurred_at: now.toISOString(),
        });
        emitted += 1;
        // (b) advance review_due to the next slot (null ⇒ event-only cadence, left as-is).
        const next = rescheduleReviewDue(d.cadence, now);
        if (next) {
          await gw.bumpReviewDue(d.goal_id, next);
          rescheduled += 1;
        }
      } catch {
        errors += 1; // per-goal isolation: one failure never aborts the batch
      }
    }

    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: emitted,
      cost_ms: ctx.now().getTime() - startedAt.getTime(),
      // A run with per-goal errors is NOT clean — 'degraded' (decideCronReport surfaces it) so a partial
      // run is distinguishable from a healthy 'completed' (OBS-2 pattern).
      status: errors > 0 ? 'degraded' : 'completed',
      notes:
        `${emitted} review event(s) emitted, ${rescheduled} rescheduled; ${scanned} due goal(s) scanned, ${errors} error(s)` +
        (scanned >= MAX_BATCH ? ` · batch full (≥${MAX_BATCH}) — more runs will drain the rest` : ''),
      metadata: { loop: LOOP_NAME, scanned, emitted, rescheduled, errors },
    };
  } catch (err) {
    // Top-level failure (e.g. the backlog read) is swallowed: the cron never throws.
    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: emitted,
      cost_ms: ctx.now().getTime() - startedAt.getTime(),
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      metadata: { loop: LOOP_NAME, scanned, emitted, rescheduled, errors },
    };
  }
};
