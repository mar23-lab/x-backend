// projects-lifecycle.test.ts · R55-L3
//
// Route tests for PATCH /api/v1/projects/:id (rename / edit) and
// DELETE /api/v1/projects/:id (soft-archive) — the "Projects are next" half of
// the operator lifecycle ask. Mocks the DAL (ctx.set) so the suite never imports
// WorkersDalAdapter (avoids the snakecase-keys CJS/ESM collection issue other
// adapter-importing suites hit).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { projectsRoute } from '../routes/projects';

const ENV = { MBP_OWNER_USER_ID: 'user_op', DATABASE_URL: 'x' };

type UpdateCall = { ws: string; id: string; patch: Record<string, unknown>; actor: string };

function mockDal(calls: UpdateCall[], opts?: { missing?: boolean }) {
  return {
    updateProject: async (ws: string, id: string, patch: Record<string, unknown>, actor: string) => {
      calls.push({ ws, id, patch, actor });
      if (opts?.missing) return null;
      return {
        id, workspace_id: ws,
        name: typeof patch.name === 'string' ? patch.name : 'Existing name',
        status: typeof patch.status === 'string' ? patch.status : 'active',
        description: typeof patch.description === 'string' ? patch.description : null,
        metadata: {}, scope_binding: null, scope_binding_updated_at: null,
        scope_binding_updated_by: null, parent_project_id: null,
        created_at: '2026-05-01T00:00:00.000Z', updated_at: '2026-06-01T00:00:00.000Z',
      };
    },
  };
}

function appFor(auth: Record<string, unknown>, calls: UpdateCall[], opts?: { missing?: boolean }) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', mockDal(calls, opts) as never);
    await next();
  });
  app.route('/api/v1', projectsRoute);
  return app;
}

function send(method: string, auth: Record<string, unknown>, id: string, body?: Record<string, unknown>, opts?: { missing?: boolean }) {
  const calls: UpdateCall[] = [];
  const app = appFor(auth, calls, opts);
  return app.request(`/api/v1/projects/${id}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, ENV as never).then((res) => ({ res, calls }));
}

const OPERATOR = { user_id: 'user_op', role: 'operator', workspace_id: 'mbp-private' };

describe('PATCH /projects/:id · rename / edit (R55-L3)', () => {
  it('operator renames a project → 200, DAL called with name + actor', async () => {
    const { res, calls } = await send('PATCH', OPERATOR, 'proj_1', { name: 'New project name' });
    expect(res.status).toBe(200);
    const json = await res.json() as { project: { name: string } };
    expect(json.project.name).toBe('New project name');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.patch.name).toBe('New project name');
    expect(calls[0]!.actor).toBe('user_op');
    expect(calls[0]!.ws).toBe('mbp-private');
  });

  it('owner edits description → 200', async () => {
    const { res, calls } = await send('PATCH', { ...OPERATOR, role: 'owner' }, 'proj_1', { description: 'updated desc' });
    expect(res.status).toBe(200);
    expect(calls[0]!.patch.description).toBe('updated desc');
  });

  it('no editable fields → 400', async () => {
    const { res } = await send('PATCH', OPERATOR, 'proj_1', {});
    expect(res.status).toBe(400);
  });

  it('invalid status → 400 (DAL not called)', async () => {
    const { res, calls } = await send('PATCH', OPERATOR, 'proj_1', { status: 'banana' });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('client role → 403', async () => {
    const { res, calls } = await send('PATCH', { ...OPERATOR, role: 'client' }, 'proj_1', { name: 'x' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('member role → 403', async () => {
    const { res } = await send('PATCH', { ...OPERATOR, role: 'member' }, 'proj_1', { name: 'x' });
    expect(res.status).toBe(403);
  });

  it('unknown id (DAL returns null) → 404', async () => {
    const { res } = await send('PATCH', OPERATOR, 'proj_missing', { name: 'x' }, { missing: true });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /projects/:id · soft-archive (R55-L3)', () => {
  it('operator archives → 200 {ok, archived}, DAL called with status=archived', async () => {
    const { res, calls } = await send('DELETE', OPERATOR, 'proj_1');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; archived: boolean; project: { status: string } };
    expect(json.ok).toBe(true);
    expect(json.archived).toBe(true);
    expect(json.project.status).toBe('archived');
    expect(calls[0]!.patch.status).toBe('archived');
  });

  it('client role → 403', async () => {
    const { res, calls } = await send('DELETE', { ...OPERATOR, role: 'client' }, 'proj_1');
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('archiving an unknown id → 404', async () => {
    const { res } = await send('DELETE', OPERATOR, 'proj_missing', undefined, { missing: true });
    expect(res.status).toBe(404);
  });
});
