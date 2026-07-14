// decisions-route.test.ts · ARCH-006 W6 · first-class decisions
// Route tests for GET/POST /api/v1/decisions[/:id]. Asserts operator-only tenancy, scope pass-through,
// 404 when not the operator's, create authorizes the owned workspace + validates verdict/context, and
// the best-effort event mirror never blocks the create. DAL mocked.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

const DECISION = {
  id: 'decision-abc', workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux', event_id: 'evt-1',
  actor_user_id: MBP_OWNER, kind: 'governance', verdict: 'approved', context: 'Ship the unified read-model',
  criteria: [{ option: 'ship', weight: 1 }], rollback: 'revert PR', causation_id: 'evt-1',
  decided_at: '2026-06-11T03:00:00.000Z', created_at: '2026-06-11T03:00:00.000Z', updated_at: '2026-06-11T03:00:00.000Z',
};

type Capture = { listArgs?: unknown[]; getArgs?: unknown[]; created?: Record<string, unknown>; event?: Record<string, unknown> };

function appWith(auth: Record<string, unknown>, dalOverride: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dalOverride as never);
    await next();
  });
  app.route('/api/v1', workspacesRoute);
  return app;
}

function fullDal(cap: Capture): Record<string, unknown> {
  return {
    listWorkspacesForOperator: async (_ids: string[]) => [{ id: 'org_3EG82' }, { id: 'mbp-private' }],
    listDecisionsForOperator: async (ids: string[], scope: unknown, limit: number) => { cap.listArgs = [ids, scope, limit]; return [DECISION]; },
    getDecisionForOperator: async (ids: string[], id: string) => {
      cap.getArgs = [ids, id];
      if (id !== DECISION.id) return null;
      return { decision: DECISION, sign_offs: [{ id: 'so-1', event_id: 'evt-1', user_id: MBP_OWNER, verdict: 'approved', comment: null, signed_at: '2026-06-11T03:01:00.000Z' }], audit_trail: [{ action: 'decision_approved', target_type: 'decision', target_id: DECISION.id, causation_id: 'evt-1', occurred_at: '2026-06-11T03:00:00.000Z' }] };
    },
    createDecision: async (input: Record<string, unknown>) => { cap.created = input; return { ...DECISION, id: 'decision-new', ...input }; },
    upsertEvent: async (_ws: string, event: Record<string, unknown>) => { cap.event = event; return { id: event.id, created: true }; },
  };
}

const post = (auth: Record<string, unknown>, body: Record<string, unknown>, dal: Record<string, unknown>) =>
  appWith(auth, dal).request('/api/v1/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, ENV as never);

describe('GET /api/v1/decisions', () => {
  it('403 for a non-operator', async () => {
    const res = await appWith({ user_id: 'someone-else' }, fullDal({})).request('/api/v1/decisions', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(403);
  });
  it('lists + passes the operator identity-set + scope to the DAL', async () => {
    const cap: Capture = {};
    const res = await appWith({ user_id: MBP_OWNER }, fullDal(cap)).request('/api/v1/decisions?workspace_id=org_3EG82&event_id=evt-1', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decisions: unknown[] };
    expect(body.decisions.length).toBe(1);
    expect((cap.listArgs as unknown[])[0]).toContain(MBP_OWNER);
    expect((cap.listArgs as [unknown, { workspace_id: string; event_id: string }])[1]).toMatchObject({ workspace_id: 'org_3EG82', event_id: 'evt-1' });
  });
  it('degrades to [] when the DAL lacks the method (030 not applied)', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, { listWorkspacesForOperator: async () => [] }).request('/api/v1/decisions', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { decisions: unknown[] }).decisions).toEqual([]);
  });
});

describe('GET /api/v1/decisions/:id', () => {
  it('returns the decision + its sign-offs + audit trail', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, fullDal({})).request('/api/v1/decisions/decision-abc', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: { id: string }; sign_offs: unknown[]; audit_trail: unknown[] };
    expect(body.decision.id).toBe('decision-abc');
    expect(body.sign_offs.length).toBe(1);
    expect(body.audit_trail.length).toBe(1);
  });
  it('404 when the decision is not the operator\'s', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, fullDal({})).request('/api/v1/decisions/decision-someone-else', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/decisions', () => {
  it('400 when context missing', async () => {
    const res = await post({ user_id: MBP_OWNER }, { workspace_id: 'org_3EG82', verdict: 'approved' }, fullDal({}));
    expect(res.status).toBe(400);
  });
  it('400 when verdict is not allowed', async () => {
    const res = await post({ user_id: MBP_OWNER }, { workspace_id: 'org_3EG82', verdict: 'maybe', context: 'x' }, fullDal({}));
    expect(res.status).toBe(400);
  });
  it('403 when the target workspace is not owned', async () => {
    const res = await post({ user_id: MBP_OWNER }, { workspace_id: 'not-mine', verdict: 'approved', context: 'x' }, fullDal({}));
    expect(res.status).toBe(403);
  });
  it('201 creates with actor_user_id + records a first-class event', async () => {
    const cap: Capture = {};
    const res = await post({ user_id: MBP_OWNER }, { workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux', event_id: 'evt-1', verdict: 'approved', context: 'Ship it', rollback: 'revert' }, fullDal(cap));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { decision: { id: string }; event_recorded: boolean };
    expect(body.event_recorded).toBe(true);
    expect((cap.created as { actor_user_id: string }).actor_user_id).toBe(MBP_OWNER);
    expect(String((cap.event as { id: string }).id)).toMatch(/^evt_decision_/);
    expect((cap.event as { agent_id: string }).agent_id).toBe('xlooop:operator-action');
    expect((cap.event as { status: string }).status).toBe('completed');
  });
  it('a rejected decision records the event as needs_review', async () => {
    const cap: Capture = {};
    await post({ user_id: MBP_OWNER }, { workspace_id: 'org_3EG82', verdict: 'rejected', context: 'No' }, fullDal(cap));
    expect((cap.event as { status: string }).status).toBe('needs_review');
  });
  it('a failing event mirror NEVER blocks the create (still 201)', async () => {
    const dal = fullDal({});
    dal.upsertEvent = async () => { throw new Error('events table missing'); };
    const res = await post({ user_id: MBP_OWNER }, { workspace_id: 'org_3EG82', verdict: 'approved', context: 'x' }, dal);
    expect(res.status).toBe(201);
    expect((await res.json() as { event_recorded: boolean }).event_recorded).toBe(false);
  });
});
