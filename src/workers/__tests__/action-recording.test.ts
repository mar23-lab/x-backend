// action-recording.test.ts · ARCH-006 W1.2 — tiered provenance
//
// The operator asked "I did actions, did you record those?". Before this, the only operator action that
// became a chief-of-staff-visible operation_event was explicit intent-creation; connecting a source and
// signing off were invisible to the chat. These tests assert the lifecycle routes now emit a first-class
// OPERATION-tier event (best-effort, never blocking the live action), so the chief-of-staff sees the
// operator's own work. DAL mocked (no WorkersDalAdapter import).

import { describe, it, expect, vi } from 'vitest';
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

  it('rejects null-bound OAuth sources before binding them to a project', async () => {
    const createProjectSourceBinding = vi.fn(async () => ({ id: 'bind-null', source_kind: 'github_repo' }));
    const dal = {
      getUserSource: async () => ({ id: 'src_legacy', user_id: 'user_op', provider: 'github', workspace_id: null }),
      createProjectSourceBinding,
    };
    const app = mount(projectsRoute, dal);
    const res = await app.request('/api/v1/projects/p1/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_kind: 'github_repo', user_source_connection_id: 'src_legacy', source_ref: { repo: 'org/repo' }, status: 'connected' }),
    }, ENV as never);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(409);
    expect(body.code).toBe('SOURCE_WORKSPACE_BINDING_REQUIRED');
    expect(createProjectSourceBinding).not.toHaveBeenCalled();
  });

  it('rejects OAuth sources from a different workspace before project binding', async () => {
    const createProjectSourceBinding = vi.fn(async () => ({ id: 'bind-cross', source_kind: 'github_repo' }));
    const dal = {
      getUserSource: async () => ({ id: 'src_other', user_id: 'user_op', provider: 'github', workspace_id: 'other-workspace' }),
      createProjectSourceBinding,
    };
    const app = mount(projectsRoute, dal);
    const res = await app.request('/api/v1/projects/p1/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_kind: 'github_repo', user_source_connection_id: 'src_other', source_ref: { repo: 'org/repo' }, status: 'connected' }),
    }, ENV as never);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(403);
    expect(body.code).toBe('SOURCE_WORKSPACE_MISMATCH');
    expect(createProjectSourceBinding).not.toHaveBeenCalled();
  });

  it('allows explicitly same-workspace OAuth sources to bind to a project', async () => {
    const createProjectSourceBinding = vi.fn(async () => ({ id: 'bind-ok', source_kind: 'github_repo' }));
    const events: EventCall[] = [];
    const dal = {
      getUserSource: async () => ({ id: 'src_ok', user_id: 'user_op', provider: 'github', workspace_id: 'mbp-private' }),
      createProjectSourceBinding,
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { id: String(event.id), created: true }; },
    };
    const app = mount(projectsRoute, dal);
    const res = await app.request('/api/v1/projects/p1/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_kind: 'github_repo', user_source_connection_id: 'src_ok', source_ref: { repo: 'org/repo' }, status: 'connected' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    expect(createProjectSourceBinding).toHaveBeenCalledOnce();
    expect(createProjectSourceBinding.mock.calls[0][0]).toBe('mbp-private');
    expect(events).toHaveLength(1);
  });
});

describe('ARCH-006 W1.2 — sign-off records an operation-tier event', () => {
  it('POST /sign-offs (approved) returns the atomic operation-event receipt', async () => {
    const calls: unknown[][] = [];
    const dal = {
      createSignOff: async (...args: unknown[]) => { calls.push(args); return { id: 'so-1', audit_event_id: 'evt_signoff_so_1', verdict: 'approved' }; },
    };
    const app = mount(signOffsRoute, dal);
    const res = await app.request('/api/v1/sign-offs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-123', verdict: 'approved', comment: 'looks good' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toMatchObject({ event_id: 'evt-123', verdict: 'approved' });
    expect(typeof calls[0][3]).toBe('string');
    const body = await res.json() as any;
    expect(body.receipt_id).toBe('signoff:so-1');
    expect(body.receipt).toMatchObject({
      schema_id: 'xlooop.signoff_receipt.v1',
      event_id: 'evt-123',
      workspace_id: 'mbp-private',
      actor_user_id: 'user_op',
      decision_kind: 'approval',
      audit_event_id: 'evt_signoff_so_1',
    });
  });

  it('a rejected sign-off returns its atomic audit-event id', async () => {
    const dal = {
      createSignOff: async () => ({ id: 'so-2', audit_event_id: 'evt_signoff_so_2', verdict: 'rejected' }),
    };
    const app = mount(signOffsRoute, dal);
    const res = await app.request('/api/v1/sign-offs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-9', verdict: 'rejected' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    expect((await res.json() as any).receipt.audit_event_id).toBe('evt_signoff_so_2');
  });

  it('records request-changes as a noted decision with an explicit receipt kind', async () => {
    const dal = {
      createSignOff: async (_ws: string, _user: string, input: Record<string, unknown>) => ({ id: 'so-4', audit_event_id: 'evt_signoff_so_4', ...input, signed_at: '2026-07-15T00:00:00.000Z' }),
    };
    const app = mount(signOffsRoute, dal);
    const res = await app.request('/api/v1/sign-offs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-10', verdict: 'noted', decision_kind: 'request_changes', comment: 'Add the missing acceptance criteria.' }),
    }, ENV as never);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.receipt.decision_kind).toBe('request_changes');
    expect(body.receipt.audit_event_id).toBe('evt_signoff_so_4');
  });

  it('rejects request-changes without a reason', async () => {
    const app = mount(signOffsRoute, { createSignOff: async () => { throw new Error('must not run'); } });
    const res = await app.request('/api/v1/sign-offs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-10', verdict: 'noted', decision_kind: 'request_changes' }),
    }, ENV as never);
    expect(res.status).toBe(400);
  });

  it('fails closed when the atomic sign-off transaction fails', async () => {
    const dal = {
      createSignOff: async () => { throw new Error('atomic lineage write failed'); },
    };
    const app = mount(signOffsRoute, dal);
    const res = await app.request('/api/v1/sign-offs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'evt-1', verdict: 'approved' }),
    }, ENV as never);
    expect(res.status).toBe(500);
  });
});
