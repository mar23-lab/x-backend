// operations-queue-consumer.test.ts · 2026-06-12
// Unit tests for the execution-pipeline executor (services/operations-queue-consumer.ts) + its
// chaining into the hourly reclassify slot. DAL fully mocked (mirror scheduled-digest-sweep test
// style). Asserts the four safety properties by construction:
//   1. SAFE-BY-DEFAULT — executorEnabled=false → 0 DB calls, status skipped.
//   2. GOVERNED — a verb's result is APPENDED needs_review/pending (never auto-posted).
//   3. RUN-EXACTLY-ONCE — a lost atomic claim (updated===0) skips without running the verb.
//   4. NEVER-THROWS — an unknown verb / a throwing verb transitions THAT request to 'failed'; drain
//      completes.
// APPEND-ONLY MODEL (ADR-XLOOP-IA-001 inv. 2): the request row's content is never mutated — the
// executor INSERTs a separate result event (upsertEvent) and only re-points the request's STATUS.

import { describe, it, expect, vi } from 'vitest';
import { runOperationsQueueConsumer } from '../services/operations-queue-consumer';
import { CRON_BY_EXPRESSION } from '../crons';

const NOW = () => new Date('2026-06-12T00:45:00.000Z');

const SUMMARY = {
  workspace_id: 'ws1', events_total: 10, events_completed: 6, signoffs_total: 3, projects_total: 2,
  connected_sources: 1, first_activity_at: null, last_activity_at: null, days_of_history: 5,
  needs_you: 2, since: null, events_since: 0, signoffs_since: 0,
};

// W3 Track A · the workspace plan listWorkspacePlan returns, for the roadmap verb.
const PLAN = {
  domains: [
    { id: 'd1', label: 'Career', workspace_id: 'ws1',
      roadmaps: [{ id: 'r1', domain_id: 'd1', title: 'Ship v1', status: 'active', items_total: 4, items_done: 2, updated_at: '2026-06-10T00:00:00Z' }],
      goals: [{ id: 'g1', domain_id: 'd1', title: 'Reach 10 pilots', status: 'active', metric_name: 'pilots', metric_unit: null, target_value: 10, current_value: 2, updated_at: '2026-06-10T00:00:00Z' }] },
    { id: 'd2', label: 'Health', workspace_id: 'ws1',
      roadmaps: [],
      goals: [{ id: 'g2', domain_id: 'd2', title: 'Run weekly', status: 'active', metric_name: 'runs', metric_unit: null, target_value: 4, current_value: 1, updated_at: '2026-06-10T00:00:00Z' }] },
  ],
};

// A queued operation_events row as listEventsForOperator would return it.
const EV = (id: string, next_action: string | null, ws = 'ws1') => ({
  id, workspace_id: ws, project_id: null, source_tool: 'operator', agent_id: null, intent_id: null,
  status: 'queued', summary: `command ${id}`, body: null, evidence_link: null,
  visibility: 'internal_workspace', permission_scope: null, risk: null, approval_state: 'none',
  next_action, occurred_at: '2026-06-11T00:00:00Z',
});

const page = (events: any[]) => ({ events, pagination: { has_more: false, next_before: null } });

// A minimal DAL double — only the four methods the consumer touches, plus per-call spies.
function makeDal(opts: {
  queued?: any[];
  // override per (eventId, patch, expectedStatus) → controls claim/finalize race outcomes
  updateResult?: (eventId: string, patch: any, expectedStatus: string | null | undefined) => { updated: number };
  summaryFor?: (id: string) => any; // override (or throw) the activity summary
}) {
  const listEventsForOperator = vi.fn(async (_ids: string[], _opts: any) => page(opts.queued ?? []));
  const getWorkspaceActivitySummary = vi.fn(async (id: string) =>
    opts.summaryFor ? opts.summaryFor(id) : { ...SUMMARY, workspace_id: id },
  );
  const updateEventStatusForOperator = vi.fn(
    async (_ids: string[], eventId: string, patch: any, expectedStatus?: string | null) =>
      opts.updateResult ? opts.updateResult(eventId, patch, expectedStatus) : { updated: 1 },
  );
  const upsertEvent = vi.fn(async (_ws: string, event: any) => ({ id: event.id, created: true }));
  const listWorkspacePlan = vi.fn(async (_id: string) => PLAN);
  return {
    dal: { listEventsForOperator, getWorkspaceActivitySummary, updateEventStatusForOperator, upsertEvent, listWorkspacePlan } as any,
    spies: { listEventsForOperator, getWorkspaceActivitySummary, updateEventStatusForOperator, upsertEvent, listWorkspacePlan },
  };
}

const OWNER = ['user_op'];
const run = (dal: any, executorEnabled: boolean) =>
  runOperationsQueueConsumer({ dal, ownerUserIds: OWNER, executorEnabled, now: NOW });

describe('runOperationsQueueConsumer · service', () => {
  // (1) SAFE-BY-DEFAULT
  it('executor OFF → status skipped, reason executor_disabled, ZERO DB calls', async () => {
    const { dal, spies } = makeDal({ queued: [EV('e1', 'execute:digest')] });
    const res = await run(dal, false);
    expect(res).toEqual({
      status: 'skipped', reason: 'executor_disabled',
      scanned: 0, executed: 0, failed: 0, skipped_unclaimed: 0, skipped_foreign: 0, errors: 0,
    });
    expect(spies.listEventsForOperator).not.toHaveBeenCalled();
    expect(spies.updateEventStatusForOperator).not.toHaveBeenCalled();
    expect(spies.getWorkspaceActivitySummary).not.toHaveBeenCalled();
    expect(spies.upsertEvent).not.toHaveBeenCalled();
  });

  // (2) GOVERNED happy path — known verb claimed, run, result APPENDED pending, request completed.
  it('execute:digest → claim queued→running, APPENDS needs_review/pending result, request completed', async () => {
    const { dal, spies } = makeDal({ queued: [EV('e1', 'execute:digest')] });
    const res = await run(dal, true);

    expect(res.status).toBe('completed');
    expect(res.scanned).toBe(1);
    expect(res.executed).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.skipped_unclaimed).toBe(0);
    expect(res.skipped_foreign).toBe(0);
    expect(res.errors).toBe(0);

    // Two status updates: the atomic claim (queued→running) then the terminal (running→completed).
    expect(spies.updateEventStatusForOperator).toHaveBeenCalledTimes(2);
    const [claimCall, completeCall] = spies.updateEventStatusForOperator.mock.calls;
    expect(claimCall[2]).toEqual({ status: 'running' });
    expect(claimCall[3]).toBe('queued');
    // The terminal transition is STATUS-ONLY (append-only model: never mutate content).
    expect(completeCall[2]).toEqual({ status: 'completed' });
    expect(completeCall[3]).toBe('running');
    expect(Object.keys(completeCall[2])).toEqual(['status']); // no summary/body in the patch

    // The result proposal is a SEPARATE appended event — GOVERNED (needs_review/pending).
    expect(spies.upsertEvent).toHaveBeenCalledTimes(1);
    const [, resultEvent] = spies.upsertEvent.mock.calls[0]!;
    expect(resultEvent.id).toBe('evt_exec_digest_e1'); // deterministic → idempotent + lineage link
    expect(resultEvent.status).toBe('needs_review');
    expect(resultEvent.approval_state).toBe('pending');
    expect(resultEvent.next_action).toBe('approve_to_post_digest');
    expect(typeof resultEvent.body).toBe('string');
    expect(spies.getWorkspaceActivitySummary).toHaveBeenCalledTimes(1);
    // W3-1 · the digest receipt carries a machine-readable metrics payload (closes actions->metrics)
    // sourced from the same activity summary, so downstream learning can consume it without parsing prose.
    expect(resultEvent.metadata).toBeDefined();
    expect(resultEvent.metadata.metrics).toMatchObject({
      events_total: 10, events_completed: 6, needs_you: 2,
      signoffs_total: 3, connected_sources: 1, projects_total: 2,
    });
    expect(typeof resultEvent.metadata.metrics.generated_at).toBe('string');
  });

  // (2b) W3 Track A · GOVERNED happy path for the roadmap verb — same spine as digest (read the plan
  // via listWorkspacePlan, draft, APPEND a needs_review/pending proposal, request completed).
  it('execute:roadmap → reads the plan, APPENDS needs_review/pending roadmap synthesis, request completed', async () => {
    const { dal, spies } = makeDal({ queued: [EV('e1', 'execute:roadmap')] });
    const res = await run(dal, true);

    expect(res.status).toBe('completed');
    expect(res.executed).toBe(1);
    expect(res.failed).toBe(0);
    expect(spies.listWorkspacePlan).toHaveBeenCalledTimes(1);
    expect(spies.getWorkspaceActivitySummary).not.toHaveBeenCalled(); // roadmap reads the PLAN, not activity

    expect(spies.upsertEvent).toHaveBeenCalledTimes(1);
    const [, resultEvent] = spies.upsertEvent.mock.calls[0]!;
    expect(resultEvent.id).toBe('evt_exec_roadmap_e1'); // deterministic → idempotent + lineage link
    expect(resultEvent.status).toBe('needs_review');
    expect(resultEvent.approval_state).toBe('pending');
    expect(resultEvent.next_action).toBe('approve_to_post_roadmap');
    expect(resultEvent.agent_id).toBe('xlooop:roadmap-agent');
    expect(typeof resultEvent.body).toBe('string');
    // structured plan metrics (same discipline as the digest's W3-1 metrics)
    expect(resultEvent.metadata.plan_metrics).toMatchObject({ domains: 2, roadmaps: 1, goals: 2 });
  });

  // (3a) FOREIGN — not addressed to the executor → left queued, no claim attempted.
  it('non-execute next_action → skipped_foreign, no claim, no append', async () => {
    const { dal, spies } = makeDal({ queued: [EV('e1', 'approve_to_post_digest'), EV('e2', null)] });
    const res = await run(dal, true);
    expect(res.scanned).toBe(2);
    expect(res.skipped_foreign).toBe(2);
    expect(res.executed).toBe(0);
    expect(spies.updateEventStatusForOperator).not.toHaveBeenCalled();
    expect(spies.upsertEvent).not.toHaveBeenCalled();
  });

  // (3b) RUN-EXACTLY-ONCE — claim loses the race (updated===0) → skip, verb NOT run, nothing appended.
  it('lost atomic claim (updated=0) → skipped_unclaimed, verb never runs', async () => {
    const { dal, spies } = makeDal({
      queued: [EV('e1', 'execute:digest')],
      updateResult: () => ({ updated: 0 }), // every update loses the race
    });
    const res = await run(dal, true);
    expect(res.skipped_unclaimed).toBe(1);
    expect(res.executed).toBe(0);
    expect(spies.updateEventStatusForOperator).toHaveBeenCalledTimes(1); // only the claim attempt
    expect(spies.getWorkspaceActivitySummary).not.toHaveBeenCalled();
    expect(spies.upsertEvent).not.toHaveBeenCalled();
  });

  // (4a) UNKNOWN VERB — claimed but unservable → failure note appended + request transitioned 'failed'.
  it('execute:bogus (no handler) → claimed, failure note appended, request failed', async () => {
    const { dal, spies } = makeDal({ queued: [EV('e1', 'execute:bogus')] });
    const res = await run(dal, true);
    expect(res.failed).toBe(1);
    expect(res.executed).toBe(0);
    // claim (queued→running) + terminal (running→failed)
    expect(spies.updateEventStatusForOperator).toHaveBeenCalledTimes(2);
    const failCall = spies.updateEventStatusForOperator.mock.calls[1];
    expect(failCall[2]).toEqual({ status: 'failed' });
    expect(failCall[3]).toBe('running');
    // A failure note is appended (append-only forensics) naming the bad verb.
    expect(spies.upsertEvent).toHaveBeenCalledTimes(1);
    const [, failEvent] = spies.upsertEvent.mock.calls[0]!;
    expect(failEvent.status).toBe('failed');
    expect(String(failEvent.body)).toContain('bogus');
    expect(spies.getWorkspaceActivitySummary).not.toHaveBeenCalled();
  });

  // (4b) NEVER-THROWS — the verb handler throws → request transitioned 'failed', drain completes.
  it('verb throws → request failed + note appended, drain still completes (no rejection)', async () => {
    const { dal, spies } = makeDal({
      queued: [EV('e1', 'execute:digest')],
      summaryFor: () => { throw new Error('summary blew up'); },
    });
    const res = await run(dal, true);
    expect(res.status).toBe('completed');
    expect(res.failed).toBe(1);
    expect(res.executed).toBe(0);
    expect(res.errors).toBe(0); // isolated as a verb-fail, not an orchestration error
    const failCall = spies.updateEventStatusForOperator.mock.calls[1];
    expect(failCall[2]).toEqual({ status: 'failed' });
    const [, failEvent] = spies.upsertEvent.mock.calls[0]!;
    expect(String(failEvent.body)).toContain('summary blew up');
  });

  // (4c) NEVER-THROWS top-level — listEventsForOperator itself throws → errors counter, no rejection.
  it('queue read throws → errors=1, status completed (never rejects)', async () => {
    const listEventsForOperator = vi.fn(async () => { throw new Error('db down'); });
    const dal = { listEventsForOperator } as any;
    const res = await run(dal, true);
    expect(res.status).toBe('completed');
    expect(res.errors).toBe(1);
    expect(res.executed).toBe(0);
  });

  // Mixed batch — one digest, one foreign, one unknown.
  it('mixed batch: one digest, one foreign, one unknown → 1 executed, 1 foreign, 1 failed', async () => {
    const { dal } = makeDal({
      queued: [EV('e1', 'execute:digest'), EV('e2', 'approve_to_post_digest'), EV('e3', 'execute:bogus')],
    });
    const res = await run(dal, true);
    expect(res.scanned).toBe(3);
    expect(res.executed).toBe(1);
    expect(res.skipped_foreign).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.errors).toBe(0);
  });
});

describe('reclassifyThenDrainQueue · cron composite (45 * * * *)', () => {
  const entry = CRON_BY_EXPRESSION['45 * * * *'];

  it('both flags OFF → reclassify skipped + executor inert, both reported, never throws', async () => {
    // DAL never touched: reclassify short-circuits on RECLASSIFY_CRON_ENABLED off, executor on
    // EXECUTOR_MODE off. A bare object is enough — if either loop calls a method, the test throws.
    const dal = {} as any;
    const result = await entry.handler({
      dal,
      now: () => new Date('2026-06-12T00:45:00.000Z'),
      cronExpression: '45 * * * *',
      env: {}, // no flags → both OFF
    });
    // Base comes from the reclassify skipped result; the drain is folded into metadata.
    expect(result.loop_name).toBe('reclassify_unattributed');
    expect(result.status).toBe('skipped');
    const drain = (result.metadata as any)?.ops_queue_drain;
    expect(drain).toMatchObject({ status: 'skipped', reason: 'executor_disabled' });
    expect((result.metadata as any)?.ops_queue_drain_error).toBeNull();
  });

  it('EXECUTOR_MODE=enabled (reclassify still OFF) → executor drains an empty queue, completes', async () => {
    const listEventsForOperator = vi.fn(async () => page([]));
    const dal = { listEventsForOperator } as any;
    const result = await entry.handler({
      dal,
      now: () => new Date('2026-06-12T00:45:00.000Z'),
      cronExpression: '45 * * * *',
      env: { EXECUTOR_MODE: 'enabled', MBP_OWNER_USER_ID: 'user_op' },
    });
    const drain = (result.metadata as any)?.ops_queue_drain;
    expect(drain).toMatchObject({ status: 'completed', scanned: 0, executed: 0 });
    expect(listEventsForOperator).toHaveBeenCalledTimes(1);
  });
});
