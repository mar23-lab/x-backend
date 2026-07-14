// review-schedule-cron.test.ts
//
// Stage-2 A10 · the flag-gated review-scheduler cron (crons/review-schedule.ts). Locks the
// byte-identical-off contract (flag off ⇒ ZERO DB calls, status 'skipped'), the flag-on emit+bump
// behavior (one needs_review event per due goal with a deterministic id; review_due advanced by the
// cadence), the event-only-cadence case (surfaced but not rescheduled), and per-goal error isolation.
import { describe, it, expect, vi } from 'vitest';
import { reviewScheduleCron } from '../crons/review-schedule';
import type { CronHandlerContext } from '../crons/types';

const NOW = new Date('2026-07-13T00:00:00Z');

interface Row { id: string; domain_id: string; workspace_id: string; review_cadence: string | null; review_due: string | null }

function makeCtx(rows: Row[], flag: string | undefined, overrides?: {
  upsertEvent?: (ws: string, ev: any) => Promise<{ id: string; created: boolean }>;
}) {
  const listGoalsWithReviewDue = vi.fn(async () => rows);   // gateway.listDue
  const updateGoalReviewDue = vi.fn(async () => {});         // gateway.bumpReviewDue
  const upsertEvent = vi.fn(overrides?.upsertEvent ?? (async (_ws: string, ev: any) => ({ id: ev.id, created: true })));
  const dal = { upsertEvent } as unknown as CronHandlerContext['dal'];
  const ctx: CronHandlerContext = {
    dal,
    now: () => NOW,
    cronExpression: '0 5 * * *',
    env: flag === undefined ? {} : { REVIEW_SCHEDULER_ENABLED: flag },
    reviewSchedule: { listDue: listGoalsWithReviewDue, bumpReviewDue: updateGoalReviewDue },
  };
  return { ctx, listGoalsWithReviewDue, updateGoalReviewDue, upsertEvent };
}

describe('review-scheduler cron (A10)', () => {
  it('flag OFF ⇒ skipped, ZERO DB calls (byte-identical)', async () => {
    const { ctx, listGoalsWithReviewDue, updateGoalReviewDue, upsertEvent } =
      makeCtx([{ id: 'g1', domain_id: 'd1', workspace_id: 'w1', review_cadence: 'weekly', review_due: '2026-07-01' }], undefined);
    const res = await reviewScheduleCron(ctx);
    expect(res.status).toBe('skipped');
    expect(res.actions_taken).toBe(0);
    expect(listGoalsWithReviewDue).not.toHaveBeenCalled();
    expect(updateGoalReviewDue).not.toHaveBeenCalled();
    expect(upsertEvent).not.toHaveBeenCalled();
  });

  it('flag ON ⇒ emits a needs_review event (deterministic id) + bumps review_due', async () => {
    const { ctx, upsertEvent, updateGoalReviewDue } =
      makeCtx([{ id: 'g1', domain_id: 'd1', workspace_id: 'w1', review_cadence: 'weekly review', review_due: '2026-07-01' }], 'true');
    const res = await reviewScheduleCron(ctx);
    expect(res.status).toBe('completed');
    expect(res.actions_taken).toBe(1);
    expect(upsertEvent).toHaveBeenCalledTimes(1);
    const [ws, ev] = upsertEvent.mock.calls[0]!;
    expect(ws).toBe('w1');
    expect(ev.id).toBe('evt_review_g1_2026-07-01'); // deterministic per (goal, review_due) ⇒ idempotent
    expect(ev.status).toBe('needs_review');
    expect(ev.source_tool).toBe('xlooop');
    expect(ev.agent_id).toBe('xlooop:review-scheduler'); // registered identity (agent-roles.yml, F5 fix)
    expect(ev.domain_id).toBe('d1');
    // weekly, most-overdue from 2026-07-01 → next slot after now (2026-07-13) is +7d = 2026-07-20
    expect(updateGoalReviewDue).toHaveBeenCalledWith('g1', '2026-07-20');
  });

  it('event-only cadence ⇒ surfaced but NOT rescheduled', async () => {
    const { ctx, upsertEvent, updateGoalReviewDue } =
      makeCtx([{ id: 'g2', domain_id: 'd2', workspace_id: 'w2', review_cadence: 'on material change', review_due: '2026-07-05' }], 'true');
    const res = await reviewScheduleCron(ctx);
    expect(res.status).toBe('completed');
    expect(upsertEvent).toHaveBeenCalledTimes(1);       // still surfaced
    expect(updateGoalReviewDue).not.toHaveBeenCalled(); // no cadence keyword ⇒ not auto-rescheduled
  });

  it('per-goal error isolation ⇒ degraded, batch continues', async () => {
    let n = 0;
    const { ctx, upsertEvent, updateGoalReviewDue } = makeCtx(
      [
        { id: 'g1', domain_id: 'd1', workspace_id: 'w1', review_cadence: 'weekly', review_due: '2026-06-13' }, // most overdue → first
        { id: 'g2', domain_id: 'd2', workspace_id: 'w2', review_cadence: 'weekly', review_due: '2026-07-01' },
      ],
      'true',
      { upsertEvent: async (_ws, ev) => { n += 1; if (n === 1) throw new Error('sink down'); return { id: ev.id, created: true }; } },
    );
    const res = await reviewScheduleCron(ctx);
    expect(res.status).toBe('degraded');
    expect(res.metadata!.errors).toBe(1);
    expect(upsertEvent).toHaveBeenCalledTimes(2);       // both attempted (isolation)
    expect(updateGoalReviewDue).toHaveBeenCalledTimes(1); // only the succeeding goal was bumped
  });

  it('empty backlog ⇒ completed, nothing emitted', async () => {
    const { ctx, upsertEvent } = makeCtx([], 'true');
    const res = await reviewScheduleCron(ctx);
    expect(res.status).toBe('completed');
    expect(res.actions_taken).toBe(0);
    expect(upsertEvent).not.toHaveBeenCalled();
  });
});
