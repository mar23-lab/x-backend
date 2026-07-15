// scheduled-digest-sweep.test.ts · 2026-06-08
// Unit tests for the SELF-DRIVING governed digest sweep (services/scheduled-digest-sweep.ts) +
// its chaining into the weekly weight_retune cron. DAL fully mocked (mirror agent-digest-route
// test style). Asserts the four safety properties: safe-by-default (flag OFF → 0 DB calls),
// governed (every draft is PENDING, never auto-posted), idempotent (one pending digest per
// workspace), never-throws (a failing workspace is isolated; the sweep completes).

import { describe, it, expect, vi } from 'vitest';
import { runScheduledDigestSweep } from '../services/scheduled-digest-sweep';
import { weightRetuneCron } from '../crons/weight-retune';

const NOW = () => new Date('2026-06-08T03:00:00.000Z');

const SUMMARY = {
  workspace_id: 'ws1', events_total: 10, events_completed: 6, signoffs_total: 3, projects_total: 2,
  connected_sources: 1, first_activity_at: null, last_activity_at: null, days_of_history: 5,
  needs_you: 2, since: null, events_since: 0, signoffs_since: 0,
};

const WS = (id: string) => ({
  id, name: id, owner_user_id: 'user_op', slug: null, config: {},
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
});

const emptyPage = { events: [], pagination: { has_more: false, next_before: null } };

// A minimal DAL double — only the four methods the sweep touches, plus per-call spies.
function makeDal(opts: {
  workspaces: ReturnType<typeof WS>[];
  summaryFor?: (id: string) => any;            // override per-workspace summary (or throw)
  existingEventsFor?: (id: string) => any;     // override the listEvents page per workspace
}) {
  const listWorkspacesForOperator = vi.fn(async () => opts.workspaces);
  const getWorkspaceActivitySummary = vi.fn(async (id: string) =>
    opts.summaryFor ? opts.summaryFor(id) : { ...SUMMARY, workspace_id: id },
  );
  const listEvents = vi.fn(async (id: string) =>
    opts.existingEventsFor ? opts.existingEventsFor(id) : emptyPage,
  );
  const upsertEvent = vi.fn(async (_id: string, event: Record<string, unknown>) => ({ id: event.id, created: true }));
  return {
    dal: { listWorkspacesForOperator, getWorkspaceActivitySummary, listEvents, upsertEvent } as any,
    spies: { listWorkspacesForOperator, getWorkspaceActivitySummary, listEvents, upsertEvent },
  };
}

describe('runScheduledDigestSweep · service', () => {
  // (1) SAFE-BY-DEFAULT
  it('flag OFF → status skipped, reason flag_disabled, ZERO DB calls, 0 drafted', async () => {
    const { dal, spies } = makeDal({ workspaces: [WS('ws1')] });
    const res = await runScheduledDigestSweep({ dal, ownerUserIds: ['user_op'], flagEnabled: false, now: NOW });
    expect(res).toEqual({ status: 'skipped', reason: 'flag_disabled', drafted: 0, skipped_dormant: 0, skipped_existing: 0, errors: 0 });
    // Inert: not a single DB method was touched.
    expect(spies.listWorkspacesForOperator).not.toHaveBeenCalled();
    expect(spies.getWorkspaceActivitySummary).not.toHaveBeenCalled();
    expect(spies.listEvents).not.toHaveBeenCalled();
    expect(spies.upsertEvent).not.toHaveBeenCalled();
  });

  // (2) governed draft on an active workspace with no existing digest
  it('flag ON + active workspace + no existing digest → drafts a PENDING proposal', async () => {
    const { dal, spies } = makeDal({ workspaces: [WS('ws1')] });
    const res = await runScheduledDigestSweep({ dal, ownerUserIds: ['user_op'], flagEnabled: true, now: NOW });
    expect(res.status).toBe('completed');
    expect(res.drafted).toBe(1);
    expect(res.skipped_dormant).toBe(0);
    expect(res.skipped_existing).toBe(0);
    expect(res.errors).toBe(0);
    expect(spies.upsertEvent).toHaveBeenCalledTimes(1);
    const [wsId, event] = spies.upsertEvent.mock.calls[0]!;
    expect(wsId).toBe('ws1');
    expect(event.status).toBe('needs_review');
    expect(event.approval_state).toBe('pending');
    expect(event.agent_id).toBe('xlooop:digest-agent');
    expect(event.next_action).toBe('approve_to_post_digest');
    expect(event.source_tool).toBe('xlooop');
    expect(event.visibility).toBe('internal_workspace');
    // per-workspace-per-day idempotent id (mutually idempotent with the manual route).
    expect(event.id).toBe('evt_agent_digest_ws1_2026-06-08');
    // idempotency probe used the operator role + needs_review filter.
    expect(spies.listEvents).toHaveBeenCalledWith('ws1', { status: 'needs_review', limit: 50, role: 'operator' });
  });

  // (3) DORMANT skip
  it('dormant workspace (events_total 0) → skipped_dormant, no upsertEvent', async () => {
    const { dal, spies } = makeDal({
      workspaces: [WS('ws1')],
      summaryFor: (id) => ({ ...SUMMARY, workspace_id: id, events_total: 0 }),
    });
    const res = await runScheduledDigestSweep({ dal, ownerUserIds: ['user_op'], flagEnabled: true, now: NOW });
    expect(res.skipped_dormant).toBe(1);
    expect(res.drafted).toBe(0);
    expect(spies.upsertEvent).not.toHaveBeenCalled();
    // dormant short-circuits BEFORE the idempotency read.
    expect(spies.listEvents).not.toHaveBeenCalled();
  });

  // (4) IDEMPOTENCY skip — one pending digest already exists.
  it('existing pending digest-agent proposal → skipped_existing, no upsertEvent (idempotent)', async () => {
    const { dal, spies } = makeDal({
      workspaces: [WS('ws1')],
      existingEventsFor: () => ({
        events: [{ id: 'evt_existing', agent_id: 'xlooop:digest-agent', next_action: 'approve_to_post_digest', status: 'needs_review' }],
        pagination: { has_more: false, next_before: null },
      }),
    });
    const res = await runScheduledDigestSweep({ dal, ownerUserIds: ['user_op'], flagEnabled: true, now: NOW });
    expect(res.skipped_existing).toBe(1);
    expect(res.drafted).toBe(0);
    expect(spies.upsertEvent).not.toHaveBeenCalled();
  });

  it('a NON-digest pending event does NOT block a fresh digest (only digest-agent proposals count)', async () => {
    const { dal, spies } = makeDal({
      workspaces: [WS('ws1')],
      existingEventsFor: () => ({
        // some other pending item — not the digest agent → must NOT suppress the draft.
        events: [{ id: 'evt_other', agent_id: 'xlooop:other-agent', next_action: 'do_something_else', status: 'needs_review' }],
        pagination: { has_more: false, next_before: null },
      }),
    });
    const res = await runScheduledDigestSweep({ dal, ownerUserIds: ['user_op'], flagEnabled: true, now: NOW });
    expect(res.drafted).toBe(1);
    expect(res.skipped_existing).toBe(0);
    expect(spies.upsertEvent).toHaveBeenCalledTimes(1);
  });

  // (5) GOVERNED — every drafted proposal across many workspaces is PENDING (never auto-posted).
  it('NEVER auto-posts — every drafted proposal is approval_state pending across all workspaces', async () => {
    const { dal, spies } = makeDal({ workspaces: [WS('ws1'), WS('ws2'), WS('ws3')] });
    const res = await runScheduledDigestSweep({ dal, ownerUserIds: ['user_op'], flagEnabled: true, now: NOW });
    expect(res.drafted).toBe(3);
    expect(spies.upsertEvent).toHaveBeenCalledTimes(3);
    for (const call of spies.upsertEvent.mock.calls) {
      const event = call[1] as Record<string, unknown>;
      expect(event.approval_state).toBe('pending');
      expect(event.status).toBe('needs_review');
      // governed: never 'approved'/'completed' straight out of the agent.
      expect(event.status).not.toBe('approved');
      expect(event.status).not.toBe('completed');
    }
  });

  // (6) NEVER-THROWS — one workspace whose summary throws is isolated; the others complete.
  it('a workspace whose getWorkspaceActivitySummary throws → errors++, sweep continues + completes', async () => {
    const { dal, spies } = makeDal({
      workspaces: [WS('ws1'), WS('ws-boom'), WS('ws3')],
      summaryFor: (id) => {
        if (id === 'ws-boom') throw new Error('summary blew up');
        return { ...SUMMARY, workspace_id: id };
      },
    });
    const res = await runScheduledDigestSweep({ dal, ownerUserIds: ['user_op'], flagEnabled: true, now: NOW });
    expect(res.status).toBe('completed');   // never throws
    expect(res.errors).toBe(1);
    expect(res.drafted).toBe(2);            // the two healthy workspaces still got their digest
    expect(spies.upsertEvent).toHaveBeenCalledTimes(2);
  });

  it('a top-level listWorkspacesForOperator failure is swallowed → status completed, errors 1, drafted 0', async () => {
    const dal = { listWorkspacesForOperator: vi.fn(async () => { throw new Error('db down'); }) } as any;
    const res = await runScheduledDigestSweep({ dal, ownerUserIds: ['user_op'], flagEnabled: true, now: NOW });
    expect(res.status).toBe('completed');
    expect(res.errors).toBe(1);
    expect(res.drafted).toBe(0);
  });

  // (7) AI path provenance — present → LLM; absent → deterministic fallback.
  it('AI present → LLM-drafted body; AI absent → deterministic fallback', async () => {
    // LLM path
    const llm = makeDal({ workspaces: [WS('ws1')] });
    const ai = { run: async () => ({ response: 'A productive week across the workspace; the operational record is complete and audit-ready for the period. Next: clear the items awaiting your sign-off.' }) };
    await runScheduledDigestSweep({ dal: llm.dal, ai, ownerUserIds: ['user_op'], flagEnabled: true, now: NOW });
    const llmEvent = llm.spies.upsertEvent.mock.calls[0]![1] as Record<string, unknown>;
    expect(String(llmEvent.body)).toMatch(/productive week/);

    // Deterministic path (no AI binding) — body is the compiled snapshot, not the LLM narrative.
    const det = makeDal({ workspaces: [WS('ws1')] });
    await runScheduledDigestSweep({ dal: det.dal, ownerUserIds: ['user_op'], flagEnabled: true, now: NOW });
    const detEvent = det.spies.upsertEvent.mock.calls[0]![1] as Record<string, unknown>;
    expect(String(detEvent.body)).toMatch(/snapshot of your workspace/);
    expect(String(detEvent.body)).not.toMatch(/productive week/);
  });

  it('strict model lineage fails closed before an unreceipted AI call', async () => {
    const { dal, spies } = makeDal({ workspaces: [WS('ws1')] });
    const run = vi.fn(async () => ({ response: 'This must not run.' }));

    const res = await runScheduledDigestSweep({
      dal,
      ai: { run },
      ownerUserIds: ['user_op'],
      flagEnabled: true,
      now: NOW,
      modelLineageRequired: true,
    });

    expect(res.errors).toBe(1);
    expect(res.drafted).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(spies.upsertEvent).not.toHaveBeenCalled();
  });

  it('strict model lineage wraps the scheduled AI call and closes skill lineage', async () => {
    const { dal } = makeDal({ workspaces: [WS('ws1')] });
    const finish = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({ complete: finish }));
    const complete = vi.fn(async () => [] as string[]);
    const modelLineageFactory = vi.fn(async () => ({ observer: { start }, complete }));
    const ai = { run: vi.fn(async () => ({ response: 'A source-grounded weekly digest with enough useful detail for the operator to review safely.' })) };

    const res = await runScheduledDigestSweep({
      dal,
      ai,
      ownerUserIds: ['user_op'],
      flagEnabled: true,
      now: NOW,
      modelLineageRequired: true,
      modelLineageFactory,
    });

    expect(res.drafted).toBe(1);
    expect(modelLineageFactory).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'ws1',
      principal_id: 'xlooop:digest-agent',
      role: 'automation',
      action: 'assistant:digest',
    }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

// ── Cron-level: weightRetuneCron folds the sweep into its result + actions_taken ───────────────
describe('weightRetuneCron · chains the digest sweep', () => {
  // A DAL double covering both weight_retune's own reads AND the sweep's.
  function cronDal(workspaces: ReturnType<typeof WS>[]) {
    const upsertEvent = vi.fn(async (_id: string, event: Record<string, unknown>) => ({ id: event.id, created: true }));
    return {
      dal: {
        getActiveDetectorConfig: async () => ({ version_id: 'cfg_v1' }),
        insertInferenceRun: async () => ({}),
        completeInferenceRun: async () => ({}),
        listWorkspacesForOperator: async () => workspaces,
        getWorkspaceActivitySummary: async (id: string) => ({ ...SUMMARY, workspace_id: id }),
        listEvents: async () => emptyPage,
        upsertEvent,
      } as any,
      upsertEvent,
    };
  }

  it('flag ON → invokes the sweep, folds metadata.digest_sweep, adds drafted to actions_taken', async () => {
    const { dal, upsertEvent } = cronDal([WS('ws1'), WS('ws2')]);
    const res = await weightRetuneCron({
      dal,
      now: NOW,
      cronExpression: '0 3 * * 1',
      env: { DIGEST_SWEEP_ENABLED: 'true', MBP_OWNER_USER_ID: 'user_op', MBP_OWNER_LINKED_USER_IDS: '' },
    });
    const meta = res.metadata as { digest_sweep?: { status: string; drafted: number } };
    expect(meta.digest_sweep?.status).toBe('completed');
    expect(meta.digest_sweep?.drafted).toBe(2);
    // weight_retune's own actions_taken is 0 (R50 stub) → folded total is just the sweep's drafts.
    expect(res.actions_taken).toBe(2);
    expect(upsertEvent).toHaveBeenCalledTimes(2);
  });

  it('flag OFF (default) → sweep is inert, no proposals drafted, metadata records skipped', async () => {
    const { dal, upsertEvent } = cronDal([WS('ws1')]);
    const res = await weightRetuneCron({
      dal,
      now: NOW,
      cronExpression: '0 3 * * 1',
      env: { DIGEST_SWEEP_ENABLED: 'false', MBP_OWNER_USER_ID: 'user_op' },
    });
    const meta = res.metadata as { digest_sweep?: { status: string; reason?: string; drafted: number } };
    expect(meta.digest_sweep?.status).toBe('skipped');
    expect(meta.digest_sweep?.reason).toBe('flag_disabled');
    expect(meta.digest_sweep?.drafted).toBe(0);
    expect(res.actions_taken).toBe(0);
    expect(upsertEvent).not.toHaveBeenCalled();
  });

  it('no env at all → sweep treated as flag-disabled, weight_retune still returns normally', async () => {
    const { dal, upsertEvent } = cronDal([WS('ws1')]);
    const res = await weightRetuneCron({ dal, now: NOW, cronExpression: '0 3 * * 1' });
    expect(res.status).toBe('skipped'); // R50 stub primary status
    const meta = res.metadata as { digest_sweep?: { status: string } };
    expect(meta.digest_sweep?.status).toBe('skipped');
    expect(upsertEvent).not.toHaveBeenCalled();
  });
});
