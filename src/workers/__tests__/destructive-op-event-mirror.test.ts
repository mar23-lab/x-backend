// destructive-op-event-mirror.test.ts · Recoverability doctrine (260706)
//
// Route tests for operator-action evidence on DESTRUCTIVE customer-API ops.
// Project/workspace archival still mirrors a customer-visible operation_event, best-effort.
// Source disconnect moved to the newer fail-closed audit receipt contract: no legacy
// best-effort operation_event may be required or treated as authority for success.
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

  it('DELETE /sources/:id → returns a source disconnect receipt, no best-effort mirror', async () => {
    const events: EventCall[] = [];
    let disconnectArgs: unknown[] | null = null;
    const dal = {
      getUserSource: async () => ({ id: 'src-1', workspace_id: 'ws-a', provider: 'google' }),
      disconnectUserSource: async (...args: unknown[]) => {
        disconnectArgs = args;
        return {
          disconnected: { id: 'src-1', provider: 'google' },
          source_disconnect_receipt_id: 'source-disconnect:src-1:audit-source-disconnect',
          audit_event_id: 'audit-source-disconnect',
        };
      },
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { inserted: 1 }; },
    };
    const app = appFor(sourcesRoute, { user_id: 'u1', workspace_id: 'ws-a' }, dal);
    const res = await app.request('/api/v1/sources/src-1', { method: 'DELETE' }, ENV as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { source_disconnect_receipt_id?: string; audit_event_id?: string };
    expect(body.source_disconnect_receipt_id).toBe('source-disconnect:src-1:audit-source-disconnect');
    expect(body.audit_event_id).toBe('audit-source-disconnect');
    expect(disconnectArgs).toEqual(['u1', 'src-1', 'ws-a']);
    expect(events).toHaveLength(0);
  });

  it('DELETE /sources/:id → no workspace scope still requires a receipt and no mirror', async () => {
    const events: EventCall[] = [];
    const dal = {
      getUserSource: async () => ({ id: 'src-1', provider: 'google' }),
      disconnectUserSource: async () => ({
        disconnected: { id: 'src-1', provider: 'google' },
        source_disconnect_receipt_id: 'source-disconnect:src-1:audit-source-disconnect',
        audit_event_id: 'audit-source-disconnect',
      }),
      upsertEvent: async (ws: string, event: Record<string, unknown>) => { events.push({ ws, event }); return { inserted: 1 }; },
    };
    const app = appFor(sourcesRoute, { user_id: 'u1' }, dal);
    const res = await app.request('/api/v1/sources/src-1', { method: 'DELETE' }, ENV as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { source_disconnect_receipt_id?: string; audit_event_id?: string };
    expect(body.source_disconnect_receipt_id).toBe('source-disconnect:src-1:audit-source-disconnect');
    expect(body.audit_event_id).toBe('audit-source-disconnect');
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
