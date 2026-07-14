// members-role-mutation.test.ts · PATCH /api/v1/members/:userId/role
//
// The in-app role-mutation write path (the gap prior audits flagged: workspace_members
// roles were only set at provisioning/invite time). Owner-only, tenant-scoped, audited,
// last-owner-guarded. Here we inject auth + a fake dal and assert the route contract:
// ownership gate, role validation, auth, and DAL error pass-through (last-owner 409).
//
// Authority: src/workers/routes/members.ts + src/workers/dal/workspace-member-store.ts

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { membersRoute } from '../routes/members';

function appFor(
  dal: Record<string, unknown>,
  auth: { user_id: string; workspace_id: string } = { user_id: 'op', workspace_id: 'org_a' },
) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', membersRoute);
  return app;
}

const member = {
  user_id: 'u1', workspace_id: 'org_a', role: 'operator',
  email: null, status: null, invited_by: null, joined_at: null,
};

function patch(app: ReturnType<typeof appFor>, roleBody: unknown) {
  return app.request('/api/v1/members/u1/role', {
    method: 'PATCH',
    body: JSON.stringify({ role: roleBody }),
    headers: { 'content-type': 'application/json' },
  });
}

describe('PATCH /members/:userId/role', () => {
  it('200 — an owner changes a member role; DAL called with (ws, user, role, actor)', async () => {
    const operatorOwnsWorkspace = vi.fn(async () => true);
    const setWorkspaceMemberRole = vi.fn(async () => ({ ...member, role: 'viewer' }));
    const res = await patch(appFor({ operatorOwnsWorkspace, setWorkspaceMemberRole }), 'viewer');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { member: { role: string } };
    expect(j.member.role).toBe('viewer');
    expect(setWorkspaceMemberRole).toHaveBeenCalledWith('org_a', 'u1', 'viewer', 'op');
  });

  it('403 — caller is NOT the workspace owner; DAL never called', async () => {
    const operatorOwnsWorkspace = vi.fn(async () => false);
    const setWorkspaceMemberRole = vi.fn();
    const res = await patch(appFor({ operatorOwnsWorkspace, setWorkspaceMemberRole }), 'viewer');
    expect(res.status).toBe(403);
    expect(setWorkspaceMemberRole).not.toHaveBeenCalled();
  });

  it('400 — invalid role rejected before any DAL call', async () => {
    const setWorkspaceMemberRole = vi.fn();
    const res = await patch(
      appFor({ operatorOwnsWorkspace: vi.fn(async () => true), setWorkspaceMemberRole }),
      'superadmin',
    );
    expect(res.status).toBe(400);
    expect(setWorkspaceMemberRole).not.toHaveBeenCalled();
  });

  it('401 — no authenticated user', async () => {
    const res = await patch(
      appFor(
        { operatorOwnsWorkspace: vi.fn(), setWorkspaceMemberRole: vi.fn() },
        { user_id: '', workspace_id: '' },
      ),
      'viewer',
    );
    expect(res.status).toBe(401);
  });

  it('409 — last-owner guard from the DAL is surfaced to the caller', async () => {
    const operatorOwnsWorkspace = vi.fn(async () => true);
    const setWorkspaceMemberRole = vi.fn(async () => {
      const e = new Error('cannot change the role of the last remaining owner') as Error & {
        status?: number; code?: string;
      };
      e.status = 409; e.code = 'LAST_OWNER';
      throw e;
    });
    const res = await patch(appFor({ operatorOwnsWorkspace, setWorkspaceMemberRole }), 'viewer');
    expect(res.status).toBe(409);
  });
});

// GET /members/batch — N+1 fix: batch roster read, ownership-scoped, client-blocked (matrix parity).
describe('GET /members/batch', () => {
  it('200 — returns members_by_workspace; DAL called with (ids, [caller], currentWs) so ownership is scoped', async () => {
    const listWorkspaceMembersForWorkspaces = vi.fn(async () => ({ org_a: [member], org_b: [] }));
    const app = appFor({ listWorkspaceMembersForWorkspaces });
    const res = await app.request('/api/v1/members/batch?workspace_ids=org_a,org_b');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members_by_workspace.org_a).toHaveLength(1);
    expect(body.data_class).toBe('live');
    // the caller's user_id is passed as the ONLY owner id → the store can't return unowned tenants
    expect(listWorkspaceMembersForWorkspaces).toHaveBeenCalledWith(['org_a', 'org_b'], ['op'], 'org_a');
  });

  it('403 — client role cannot batch-list members', async () => {
    const listWorkspaceMembersForWorkspaces = vi.fn(async () => ({}));
    const app = appFor({ listWorkspaceMembersForWorkspaces }, { user_id: 'c', workspace_id: 'org_a', role: 'client' } as never);
    const res = await app.request('/api/v1/members/batch?workspace_ids=org_a');
    expect(res.status).toBe(403);
    expect(listWorkspaceMembersForWorkspaces).not.toHaveBeenCalled();
  });

  it('200 empty — no workspace_ids returns {} without hitting the DAL', async () => {
    const listWorkspaceMembersForWorkspaces = vi.fn(async () => ({}));
    const res = await appFor({ listWorkspaceMembersForWorkspaces }).request('/api/v1/members/batch');
    expect(res.status).toBe(200);
    expect((await res.json()).members_by_workspace).toEqual({});
    expect(listWorkspaceMembersForWorkspaces).not.toHaveBeenCalled();
  });

  it('caps the id list at 50 (never an unbounded fan-in)', async () => {
    const listWorkspaceMembersForWorkspaces = vi.fn(async () => ({}));
    const many = Array.from({ length: 60 }, (_, i) => 'w' + i).join(',');
    await appFor({ listWorkspaceMembersForWorkspaces }).request('/api/v1/members/batch?workspace_ids=' + many);
    expect(listWorkspaceMembersForWorkspaces.mock.calls[0][0]).toHaveLength(50);
  });
});
