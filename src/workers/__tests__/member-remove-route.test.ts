// member-remove-route.test.ts · A1 (260710-B) · DELETE /members/:userId (soft member removal).
// DECLARED AXES: flag [off → 409 (inert) · on] · auth [no user → 401] · authority [non-owner → 403 ·
// owner → proceeds] · tenant binding [workspace from JWT / owned ?workspace_id] · store guards routed
// (self-removal, last-owner) surface as their store errors. The store guards themselves are unit-tested
// against a real Postgres in the migration-062 local-PG validation (scripts).

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { membersRoute } from '../routes/members';

function appFor(auth: Record<string, unknown> | null, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't'); if (auth) ctx.set('auth', auth as never); ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', membersRoute);
  return app;
}
const del = (app: Hono, path: string, env: Record<string, unknown>) =>
  app.request(path, { method: 'DELETE' }, env as never);

const OWNER = { user_id: 'u_owner', workspace_id: 'org_acme', role: 'owner' };
const ON = { DATABASE_URL: 'p', MEMBER_REMOVAL_ENABLED: 'true' } as never;
const OFF = { DATABASE_URL: 'p' } as never;

function dalStub(over: Record<string, unknown> = {}) {
  return {
    operatorOwnsWorkspace: vi.fn(async () => true),
    removeWorkspaceMember: vi.fn(async (w: string, u: string) => ({
      removed: { user_id: u, workspace_id: w, removed_at: '2026-07-10T00:00:00Z' },
      member_mutation_receipt_id: `workspace-member:${w}:${u}:remove:audit_remove_1`,
      audit_event_id: 'audit_remove_1',
    })),
    ...over,
  };
}

describe('DELETE /members/:userId · soft member removal', () => {
  it('flag OFF (default) → 409, before any auth/authority work (inert-by-default)', async () => {
    const dal = dalStub();
    const res = await del(appFor(OWNER, dal), '/api/v1/members/u_target', OFF);
    expect(res.status).toBe(409);
    expect(dal.removeWorkspaceMember).not.toHaveBeenCalled();
  });

  it('flag ON, no auth → 401', async () => {
    const res = await del(appFor({ user_id: '' }, dalStub()), '/api/v1/members/u_target', ON);
    expect(res.status).toBe(401);
  });

  it('flag ON, non-owner → 403 (owner-only; no removal reachable)', async () => {
    const dal = dalStub({ operatorOwnsWorkspace: vi.fn(async () => false) });
    const res = await del(appFor({ user_id: 'u_viewer', workspace_id: 'org_acme', role: 'viewer' }, dal), '/api/v1/members/u_target', ON);
    expect(res.status).toBe(403);
    expect(dal.removeWorkspaceMember).not.toHaveBeenCalled();
  });

  it('flag ON, owner → 200; removal is bound to the JWT workspace + actor', async () => {
    const dal = dalStub();
    const res = await del(appFor(OWNER, dal), '/api/v1/members/u_target', ON);
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: { user_id: string; workspace_id: string }; member_mutation_receipt_id: string; audit_event_id: string };
    expect(body.removed.user_id).toBe('u_target');
    expect(body.member_mutation_receipt_id).toMatch(/^workspace-member:/);
    expect(body.audit_event_id).toBe('audit_remove_1');
    // dal called (workspace, target, actor) — workspace + actor from the JWT, target from the path
    expect(dal.removeWorkspaceMember).toHaveBeenCalledWith('org_acme', 'u_target', 'u_owner');
  });

  it('flag ON, owner → 500 if removal does not return an audit receipt', async () => {
    const dal = dalStub({
      removeWorkspaceMember: vi.fn(async (w: string, u: string) => ({
        removed: { user_id: u, workspace_id: w, removed_at: '2026-07-10T00:00:00Z' },
      })),
    });
    const res = await del(appFor(OWNER, dal), '/api/v1/members/u_target', ON);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/MEMBER_AUDIT_RECEIPT_MISSING/);
  });

  it('flag ON, owner + ?workspace_id they own → uses that workspace', async () => {
    const dal = dalStub();
    const res = await del(appFor(OWNER, dal), '/api/v1/members/u_target?workspace_id=org_other', ON);
    expect(res.status).toBe(200);
    expect(dal.removeWorkspaceMember).toHaveBeenCalledWith('org_other', 'u_target', 'u_owner');
  });

  it('store guard errors surface (CANNOT_REMOVE_SELF 409 · LAST_OWNER 409)', async () => {
    const selfErr = Object.assign(new Error('you cannot remove yourself from the workspace'), { code: 'CANNOT_REMOVE_SELF', status: 409 });
    const dalSelf = dalStub({ removeWorkspaceMember: vi.fn(async () => { throw selfErr; }) });
    expect((await del(appFor(OWNER, dalSelf), '/api/v1/members/u_owner', ON)).status).toBe(409);

    const lastOwnerErr = Object.assign(new Error('cannot remove the last remaining owner'), { code: 'LAST_OWNER', status: 409 });
    const dalLO = dalStub({ removeWorkspaceMember: vi.fn(async () => { throw lastOwnerErr; }) });
    expect((await del(appFor(OWNER, dalLO), '/api/v1/members/u_target', ON)).status).toBe(409);
  });
});
