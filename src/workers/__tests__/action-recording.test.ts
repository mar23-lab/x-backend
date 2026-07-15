// action-recording.test.ts · ARCH-006 W1.2 — tiered provenance
//
// The operator asked "I did actions, did you record those?". Before this, the only operator action that
// became a chief-of-staff-visible operation_event was explicit intent-creation; connecting a source and
// signing off were invisible to the chat. These tests assert the lifecycle routes now emit a first-class
// OPERATION-tier event (best-effort, never blocking the live action), so the chief-of-staff sees the
// operator's own work. DAL mocked (no WorkersDalAdapter import).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { projectsRoute } from '../routes/projects';
import { signOffsRoute } from '../routes/sign-offs';

const ENV = { MBP_OWNER_USER_ID: 'user_op', DATABASE_URL: 'x' };
const OPERATOR = { user_id: 'user_op', role: 'operator', workspace_id: 'mbp-private' };

type EventCall = { ws: string; event: Record<string, unknown> };

function mount(routeMod: typeof projectsRoute | typeof signOffsRoute, dal: Record<string, unknown>, auth = OPERATOR) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', routeMod);
  return app;
}

describe('ARCH-006 W1.2 — connect-a-source records an operation-tier event', () => {
  it('POST /projects/:id/sources emits an xlooop:operator-action event carrying project_id', async () => {
    const events: EventCall[] = [];
    const dal = {
      createProjectSourceBinding: async () => ({ id: 'bind-1', source_kind: 'desktop_folder' }),
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { id: String(event.id), created: true }; },
    };
    const app = mount(projectsRoute, dal);
    const res = await app.request('/api/v1/projects/mbp-governance/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_kind: 'desktop_folder', source_ref: { path: '/Users/x/repo' }, status: 'connected' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    expect(events.length).toBe(1);
    expect(events[0].event).toMatchObject({
      source_tool: 'xlooop',
      agent_id: 'xlooop:operator-action',
      project_id: 'mbp-governance',
      status: 'completed',
      visibility: 'internal_workspace',
    });
    expect(String(events[0].event.id)).toMatch(/^evt_source_connect_/);
    expect(String(events[0].event.summary)).toMatch(/source connected/i);
  });

  it('a non-connected (pending) source records status needs_review', async () => {
    const events: EventCall[] = [];
    const dal = {
      createProjectSourceBinding: async () => ({ id: 'bind-2', source_kind: 'desktop_folder' }),
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { id: String(event.id), created: true }; },
    };
    const app = mount(projectsRoute, dal);
    const res = await app.request('/api/v1/projects/p1/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_kind: 'desktop_folder', source_ref: { path: '/x' }, status: 'pending_auth' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    expect(events[0].event.status).toBe('needs_review');
  });

  it('a throwing event mirror NEVER blocks the bind (still 201)', async () => {
    const dal = {
      createProjectSourceBinding: async () => ({ id: 'bind-3', source_kind: 'desktop_folder' }),
      upsertEvent: async () => { throw new Error('events table missing'); },
    };
    const app = mount(projectsRoute, dal);
    const res = await app.request('/api/v1/projects/p1/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_kind: 'desktop_folder', source_ref: { path: '/x' }, status: 'connected' }),
    }, ENV as never);
    expect(res.status).toBe(201);
  });
});

describe('ARCH-006 W1.2 — sign-off records an operation-tier event', () => {
  it('POST /sign-offs (approved) emits a completed operator-action event referencing the event', async () => {
    const events: EventCall[] = [];
    const dal = {
      createSignOff: async () => ({ id: 'so-1', verdict: 'approved' }),
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { id: String(event.id), created: true }; },
    };
    const app = mount(signOffsRoute, dal);
    const res = await app.request('/api/v1/sign-offs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-123', verdict: 'approved', comment: 'looks good' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    expect(events.length).toBe(1);
    expect(events[0].event).toMatchObject({ source_tool: 'xlooop', agent_id: 'xlooop:operator-action', status: 'completed' });
    expect(String(events[0].event.summary)).toMatch(/^\[sign-off approval\] evt-123/);
    expect(String(events[0].event.id)).toMatch(/^evt_signoff_/);
    const body = await res.json() as any;
    expect(body.receipt_id).toBe('signoff:so-1');
    expect(body.receipt).toMatchObject({
      schema_id: 'xlooop.signoff_receipt.v1',
      event_id: 'evt-123',
      workspace_id: 'mbp-private',
      actor_user_id: 'user_op',
      decision_kind: 'approval',
    });
  });

  it('a rejected sign-off records status needs_review (the item stays open)', async () => {
    const events: EventCall[] = [];
    const dal = {
      createSignOff: async () => ({ id: 'so-2', verdict: 'rejected' }),
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { id: String(event.id), created: true }; },
    };
    const app = mount(signOffsRoute, dal);
    const res = await app.request('/api/v1/sign-offs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-9', verdict: 'rejected' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    expect(events[0].event.status).toBe('needs_review');
  });

  it('records request-changes as a noted decision with an explicit receipt kind', async () => {
    const events: EventCall[] = [];
    const dal = {
      createSignOff: async (_ws: string, _user: string, input: Record<string, unknown>) => ({ id: 'so-4', ...input, signed_at: '2026-07-15T00:00:00.000Z' }),
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { id: String(event.id), created: true }; },
    };
    const app = mount(signOffsRoute, dal);
    const res = await app.request('/api/v1/sign-offs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-10', verdict: 'noted', decision_kind: 'request_changes', comment: 'Add the missing acceptance criteria.' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.receipt.decision_kind).toBe('request_changes');
    expect(events[0].event.summary).toBe('[sign-off request_changes] evt-10');
    expect(events[0].event.body).toBe('Add the missing acceptance criteria.');
    expect(events[0].event.status).toBe('needs_review');
  });

  it('rejects request-changes without a reason', async () => {
    const app = mount(signOffsRoute, { createSignOff: async () => { throw new Error('must not run'); } });
    const res = await app.request('/api/v1/sign-offs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-10', verdict: 'noted', decision_kind: 'request_changes' }),
    }, ENV as never);
    expect(res.status).toBe(400);
  });

  it('a throwing event mirror NEVER blocks the sign-off (still 201)', async () => {
    const dal = {
      createSignOff: async () => ({ id: 'so-3', verdict: 'approved' }),
      upsertEvent: async () => { throw new Error('db down'); },
    };
    const app = mount(signOffsRoute, dal);
    const res = await app.request('/api/v1/sign-offs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-1', verdict: 'approved' }),
    }, ENV as never);
    expect(res.status).toBe(201);
  });
});
