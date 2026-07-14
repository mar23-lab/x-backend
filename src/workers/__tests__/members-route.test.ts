// members-route.test.ts · Stage 3 · GET /api/v1/members
// Real workspace members from the DB (workspace_members LEFT JOIN users). Workspace-scoped:
// reads the auth's OWN workspace only (never another tenant). Honest-empty + never-5xx.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { membersRoute } from '../routes/members';

const ENV = { DATABASE_URL: 'x' };

function appFor(auth: Record<string, unknown> | null, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    if (auth) ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', membersRoute);
  return app;
}

const MEMBER = {
  user_id: 'user_2', workspace_id: 'org_abc', role: 'viewer',
  email: 'member@real.example', status: 'approved',
  invited_by: 'user_1', joined_at: '2026-02-01T00:00:00.000Z',
};

describe('GET /api/v1/members', () => {
  it("returns the real members of the caller's workspace (scoped to auth.workspace_id)", async () => {
    const cap: { wsId?: string } = {};
    const app = appFor({ user_id: 'user_1', workspace_id: 'org_abc' }, {
      listWorkspaceMembers: async (wsId: string) => { cap.wsId = wsId; return [MEMBER]; },
    });
    const res = await app.request('/api/v1/members', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<Record<string, unknown>>; workspace_id: string; count: number };
    expect(cap.wsId).toBe('org_abc');           // scoped to the caller's own workspace
    expect(body.workspace_id).toBe('org_abc');
    expect(body.count).toBe(1);
    expect(body.members[0]).toMatchObject({ user_id: 'user_2', role: 'viewer', email: 'member@real.example' });
  });

  it('returns an honest empty roster (never fabricated) when there are no members', async () => {
    const app = appFor({ user_id: 'user_1', workspace_id: 'org_empty' }, {
      listWorkspaceMembers: async () => [],
    });
    const res = await app.request('/api/v1/members', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: unknown[]; count: number };
    expect(body.members).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('never 5xx when the DAL throws — degrades to an empty roster', async () => {
    const app = appFor({ user_id: 'user_1', workspace_id: 'org_abc' }, {
      listWorkspaceMembers: async () => { throw new Error('workspace_members unavailable'); },
    });
    const res = await app.request('/api/v1/members', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: unknown[] };
    expect(body.members).toEqual([]);
  });

  it('is 403 when the session has no workspace', async () => {
    const app = appFor({ user_id: 'user_1' }, { listWorkspaceMembers: async () => [] });
    const res = await app.request('/api/v1/members', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(403);
  });

  it('is 401 when auth is missing', async () => {
    const app = appFor(null, { listWorkspaceMembers: async () => [] });
    const res = await app.request('/api/v1/members', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(401);
  });

  it('reads another workspace the caller OWNS via ?workspace_id (ownership ok)', async () => {
    const cap: { ownsArgs?: unknown[]; listed?: string } = {};
    const app = appFor({ user_id: 'user_1', workspace_id: 'org_current' }, {
      operatorOwnsWorkspace: async (ids: string[], wsId: string) => { cap.ownsArgs = [ids, wsId]; return true; },
      listWorkspaceMembers: async (wsId: string) => { cap.listed = wsId; return [MEMBER]; },
    });
    const res = await app.request('/api/v1/members?workspace_id=org_other', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_id: string; count: number };
    expect(cap.ownsArgs).toEqual([['user_1'], 'org_other']);   // ownership checked with the caller's id
    expect(cap.listed).toBe('org_other');                      // listed the REQUESTED workspace
    expect(body.workspace_id).toBe('org_other');
    expect(body.count).toBe(1);
  });

  it('is 403 for ?workspace_id the caller does NOT own (tenant guard)', async () => {
    const app = appFor({ user_id: 'user_1', workspace_id: 'org_current' }, {
      operatorOwnsWorkspace: async () => false,
      listWorkspaceMembers: async () => { throw new Error('must not be reached'); },
    });
    const res = await app.request('/api/v1/members?workspace_id=org_someone_else', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(403);
  });
});
