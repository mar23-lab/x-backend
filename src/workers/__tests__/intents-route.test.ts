// intents-route.test.ts · 2026-06-10 · Wave 5b
// Route tests for the first-class intents surface (GET/POST /api/v1/intents[/:id][/status]). Asserts
// operator-only tenancy, that reads pass the operator identity-set + scope through to the DAL, that the
// lineage read 404s when the intent is not the operator's, and that create authorizes the target
// workspace is owned before writing. DAL mocked.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

const INTENT = {
  id: 'intent-abc', workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux', domain_id: null,
  title: 'Ship the unified read-model', summary: 'Backfilled from 4 linked events', status: 'active',
  owner_user_id: MBP_OWNER, derived_from: null, origin: 'backfill',
  created_at: '2026-06-09T03:00:00.000Z', updated_at: '2026-06-09T03:00:00.000Z',
};

type Capture = { listArgs?: unknown[]; lineageArgs?: unknown[]; created?: Record<string, unknown>; statusArgs?: unknown[] };

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
    listIntentsForOperator: async (ids: string[], scope: unknown, limit: number) => {
      cap.listArgs = [ids, scope, limit];
      return [INTENT];
    },
    getIntentLineageForOperator: async (ids: string[], id: string) => {
      cap.lineageArgs = [ids, id];
      if (id !== INTENT.id) return null;
      return { intent: INTENT, child_events: [{ id: 'e1', summary: 'commit', status: 'completed', occurred_at: '2026-06-09T03:13:00.000Z' }], derived_intents: [] };
    },
    createIntent: async (input: Record<string, unknown>) => {
      cap.created = input;
      return { ...INTENT, id: 'intent-new', ...input };
    },
    // ARCH-005 action-recording: POST /intents mirrors the intent into a first-class event.
    upsertEvent: async (_ws: string, event: Record<string, unknown>) => {
      (cap as Record<string, unknown>).event = event;
      return { id: event.id, created: true };
    },
    updateIntentStatusForOperator: async (ids: string[], id: string, status: string) => {
      cap.statusArgs = [ids, id, status];
      if (id !== INTENT.id) return null;
      return { ...INTENT, status };
    },
  };
}

describe('GET /api/v1/intents', () => {
  it('403 for a non-operator', async () => {
    const app = appWith({ user_id: 'someone-else' }, fullDal({}));
    const res = await app.request('/api/v1/intents?workspace_id=org_3EG82', {}, ENV as never);
    expect(res.status).toBe(403);
  });

  it('lists the operator intents and passes the identity-set + scope to the DAL', async () => {
    const cap: Capture = {};
    const app = appWith({ user_id: MBP_OWNER }, fullDal(cap));
    const res = await app.request('/api/v1/intents?workspace_id=org_3EG82&project_id=org_3EG82-cockpit-ux', {}, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intents: Array<Record<string, unknown>> };
    expect(body.intents).toHaveLength(1);
    expect(body.intents[0]!.id).toBe('intent-abc');
    const [ids, scope] = cap.listArgs as [string[], Record<string, unknown>, number];
    expect(ids).toContain(MBP_OWNER);
    expect(scope.workspace_id).toBe('org_3EG82');
    expect(scope.project_id).toBe('org_3EG82-cockpit-ux');
  });

  it('degrades to an empty list when the DAL lacks the method (table not yet present)', async () => {
    const app = appWith({ user_id: MBP_OWNER }, { /* no intent methods */ });
    const res = await app.request('/api/v1/intents', {}, ENV as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { intents: unknown[] }).intents).toEqual([]);
  });
});

describe('GET /api/v1/intents/:id', () => {
  it('returns the intent + lineage (child events + derived intents)', async () => {
    const cap: Capture = {};
    const app = appWith({ user_id: MBP_OWNER }, fullDal(cap));
    const res = await app.request('/api/v1/intents/intent-abc', {}, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intent: Record<string, unknown>; child_events: unknown[]; derived_intents: unknown[] };
    expect(body.intent.id).toBe('intent-abc');
    expect(body.child_events).toHaveLength(1);
    expect(cap.lineageArgs).toEqual([[MBP_OWNER], 'intent-abc']);
  });

  it('404 when the intent is not the operator’s (DAL returns null)', async () => {
    const app = appWith({ user_id: MBP_OWNER }, fullDal({}));
    const res = await app.request('/api/v1/intents/not-mine', {}, ENV as never);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/intents', () => {
  it('400 when title is missing', async () => {
    const app = appWith({ user_id: MBP_OWNER }, fullDal({}));
    const res = await app.request('/api/v1/intents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'org_3EG82' }),
    }, ENV as never);
    expect(res.status).toBe(400);
  });

  it('403 when the target workspace is not owned by the operator', async () => {
    const app = appWith({ user_id: MBP_OWNER }, fullDal({}));
    const res = await app.request('/api/v1/intents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'do a thing', workspace_id: 'someone-elses-ws' }),
    }, ENV as never);
    expect(res.status).toBe(403);
  });

  it('creates a first-class intent owned by the operator and returns 201', async () => {
    const cap: Capture = {};
    const app = appWith({ user_id: MBP_OWNER }, fullDal(cap));
    const res = await app.request('/api/v1/intents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Wire the cockpit', workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { intent: Record<string, unknown> };
    expect(body.intent.id).toBe('intent-new');
    expect(cap.created?.title).toBe('Wire the cockpit');
    expect(cap.created?.workspace_id).toBe('org_3EG82');
    expect(cap.created?.owner_user_id).toBe(MBP_OWNER);
    expect(cap.created?.origin).toBe('operator');
  });

  it('ARCH-005: records the intent as a FIRST-CLASS operation_event (intent_id-linked) so it reaches the activity stream', async () => {
    const cap: Capture = {};
    const app = appWith({ user_id: MBP_OWNER }, fullDal(cap));
    const res = await app.request('/api/v1/intents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Ship the graph fix', workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux', summary: 'proceeding with D1' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    expect((await res.json() as { event_recorded: boolean }).event_recorded).toBe(true);
    const ev = (cap as Record<string, unknown>).event as Record<string, unknown> | undefined;
    expect(ev).toBeTruthy();
    expect(ev?.intent_id).toBe('intent-new');                 // linked to the created intent
    expect(ev?.source_tool).toBe('xlooop');
    expect(ev?.summary).toBe('[intent] Ship the graph fix');
    expect(ev?.project_id).toBe('org_3EG82-cockpit-ux');
  });

  it('ARCH-005: a failed event mirror NEVER blocks the intent create (best-effort)', async () => {
    const cap: Capture = {};
    const dal = fullDal(cap);
    dal.upsertEvent = async () => { throw new Error('events table missing'); };
    const app = appWith({ user_id: MBP_OWNER }, dal);
    const res = await app.request('/api/v1/intents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'still works', workspace_id: 'org_3EG82' }),
    }, ENV as never);
    expect(res.status).toBe(201);                              // intent still created
    expect((await res.json() as { event_recorded: boolean }).event_recorded).toBe(false);
  });
});

describe('POST /api/v1/intents/:id/status', () => {
  it('advances the lifecycle and returns the updated intent', async () => {
    const cap: Capture = {};
    const app = appWith({ user_id: MBP_OWNER }, fullDal(cap));
    const res = await app.request('/api/v1/intents/intent-abc/status', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }, ENV as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { intent: Record<string, unknown> }).intent.status).toBe('done');
    expect(cap.statusArgs).toEqual([[MBP_OWNER], 'intent-abc', 'done']);
  });

  it('404 when the intent is not found / status invalid (DAL returns null)', async () => {
    const app = appWith({ user_id: MBP_OWNER }, fullDal({}));
    const res = await app.request('/api/v1/intents/nope/status', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }, ENV as never);
    expect(res.status).toBe(404);
  });
});
