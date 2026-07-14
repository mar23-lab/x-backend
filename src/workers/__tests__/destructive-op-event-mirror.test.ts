// destructive-op-event-mirror.test.ts · Recoverability doctrine (260706)
//
// Route tests for the operator-action event mirror on DESTRUCTIVE customer-API ops.
// Backend-alignment audit (260706) found destructive endpoints emit audit_logs (operator
// trail) but NOT operation_events (customer-visible spine) — so a customer could not see
// that their project/workspace/source was archived/disconnected. These tests lock the fix:
// every destructive op mirrors a `xlooop:operator-action` event via dal.upsertEvent
// (the ADR-XLOOP-IA-001 sanctioned insert path), best-effort (a mirror failure must
// NEVER fail the destructive op itself).
//
// Mocks the DAL (ctx.set) — same pattern as projects-events-operator-overlay.test.ts.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { projectsRoute } from '../routes/projects';
import { sourcesRoute } from '../routes/sources';
import { workspacesRoute } from '../routes/workspaces';

const ENV = { MBP_OWNER_USER_ID: 'user_op', MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };
type EventCall = { ws: string; event: Record<string, unknown> };

function appFor(route: Hono, auth: Record<string, unknown>, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', route);
  return app;
}

describe('destructive-op event mirror (recoverability doctrine 260706)', () => {
  it('DELETE /projects/:id → archives AND mirrors [project archived] onto operation_events', async () => {
    const events: EventCall[] = [];
    const dal = {
      updateProject: async () => ({ id: 'proj-1', name: 'Pilot Project', status: 'archived' }),
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { inserted: 1 }; },
    };
    const app = appFor(projectsRoute, { user_id: 'u1', role: 'owner', workspace_id: 'ws-a' }, dal);
    const res = await app.request('/api/v1/projects/proj-1', { method: 'DELETE' }, ENV as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { archived: boolean }).archived).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].ws).toBe('ws-a');
    expect(events[0].event.id).toBe('evt_project_archive_proj_1');
    expect(String(events[0].event.summary)).toContain('[project archived] Pilot Project');
    expect(events[0].event.agent_id).toBe('xlooop:operator-action');
  });

  it('DELETE /projects/:id — a mirror FAILURE never fails the archive (best-effort)', async () => {
    const dal = {
      updateProject: async () => ({ id: 'proj-1', name: 'P', status: 'archived' }),
      upsertEvent: async () => { throw new Error('event spine down'); },
    };
    const app = appFor(projectsRoute, { user_id: 'u1', role: 'owner', workspace_id: 'ws-a' }, dal);
    const res = await app.request('/api/v1/projects/proj-1', { method: 'DELETE' }, ENV as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { archived: boolean }).archived).toBe(true);
  });

  it('DELETE /projects/:id/sources/:bindingId → mirrors [project source archived]', async () => {
    const events: EventCall[] = [];
    const dal = {
      archiveProjectSourceBinding: async () => ({ id: 'bind-1', source_kind: 'github_repo', source_ref: { repo: 'org/repo' }, status: 'archived' }),
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { inserted: 1 }; },
    };
    const app = appFor(projectsRoute, { user_id: 'u1', role: 'owner', workspace_id: 'ws-a' }, dal);
    const res = await app.request('/api/v1/projects/proj-1/sources/bind-1', { method: 'DELETE' }, ENV as never);
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0].event.id).toBe('evt_source_archive_bind_1');
    expect(String(events[0].event.summary)).toContain('[project source archived] github_repo · org/repo');
  });

  it('DELETE /sources/:id → mirrors [source disconnected] when auth carries a workspace', async () => {
    const events: EventCall[] = [];
    const dal = {
      getUserSource: async () => ({ id: 'src-1', provider: 'google' }),
      disconnectUserSource: async () => undefined,
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { inserted: 1 }; },
    };
    const app = appFor(sourcesRoute, { user_id: 'u1', workspace_id: 'ws-a' }, dal);
    const res = await app.request('/api/v1/sources/src-1', { method: 'DELETE' }, ENV as never);
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0].ws).toBe('ws-a');
    expect(String(events[0].event.summary)).toContain('[source disconnected] google');
  });

  it('DELETE /sources/:id → no workspace scope → disconnect still succeeds, no mirror', async () => {
    const events: EventCall[] = [];
    const dal = {
      getUserSource: async () => ({ id: 'src-1', provider: 'google' }),
      disconnectUserSource: async () => undefined,
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { inserted: 1 }; },
    };
    const app = appFor(sourcesRoute, { user_id: 'u1' }, dal);
    const res = await app.request('/api/v1/sources/src-1', { method: 'DELETE' }, ENV as never);
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it('DELETE /workspaces/:id → archives AND mirrors [workspace archived] (native workspace, operator)', async () => {
    const events: EventCall[] = [];
    const dal = {
      listWorkspacesForOperator: async () => ([{ id: 'ws-native', name: 'Native WS', config: { origin: 'native' } }]),
      updateWorkspace: async () => ({ id: 'ws-native', name: 'Native WS', config: { origin: 'native', archived: true } }),
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { inserted: 1 }; },
    };
    const app = appFor(workspacesRoute, { user_id: 'user_op', role: 'operator', workspace_id: 'ws-native' }, dal);
    const res = await app.request('/api/v1/workspaces/ws-native', { method: 'DELETE' }, ENV as never);
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0].ws).toBe('ws-native');
    expect(events[0].event.id).toBe('evt_workspace_archive_ws_native');
    expect(String(events[0].event.summary)).toContain('[workspace archived] Native WS');
  });
});
