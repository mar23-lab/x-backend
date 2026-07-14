// customer-approvals-inbox.test.ts · Lifecycle L2 (2026-06-15) · GET /admin/customer/approvals/pending
//
// The operator approval inbox: lists workspaces that consented (customer side) but are not yet
// operator-approved and not revoked — the queue the operator approves from (replacing the curl).
// Admin-gated by the adminRoutes group (requireAdmin, mounted in index.ts); here we inject auth+dal
// via test middleware and assert the route shape + query-param plumbing.
//
// Authority: src/workers/routes/admin.ts + src/workers/dal/customer-authority-store.ts

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { adminRoute } from '../routes/admin';

function appFor(dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't');
    ctx.set('auth', { user_id: 'op', workspace_id: '' } as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', adminRoute);
  return app;
}

const sampleRow = {
  workspace_id: 'org_cust',
  workspace_name: 'Customer Co',
  owner_user_id: 'user_owner',
  owner_email: 'owner@cust.com',
  consent_acked_by: 'user_owner',
  consent_acked_at: '2026-06-15T00:00:00Z',
  full_name_typed: 'Cust Owner',
  consent_version: 'authority_v1',
};

describe('GET /admin/customer/approvals/pending', () => {
  it('200 returns the pending list + count; default limit/offset', async () => {
    const listPendingCustomerAuthorityApprovals = vi.fn(async () => [sampleRow]);
    const res = await appFor({ listPendingCustomerAuthorityApprovals }).request(
      '/api/v1/admin/customer/approvals/pending', {}, {} as never,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, any>;
    expect(j.count).toBe(1);
    expect(j.pending[0]).toMatchObject({ workspace_id: 'org_cust', owner_email: 'owner@cust.com' });
    expect(listPendingCustomerAuthorityApprovals).toHaveBeenCalledOnce();
    expect(listPendingCustomerAuthorityApprovals.mock.calls[0][0]).toMatchObject({ limit: 50, offset: 0 });
  });

  it('passes ?limit and ?offset through to the DAL (clamped)', async () => {
    const listPendingCustomerAuthorityApprovals = vi.fn(async () => []);
    const res = await appFor({ listPendingCustomerAuthorityApprovals }).request(
      '/api/v1/admin/customer/approvals/pending?limit=10&offset=20', {}, {} as never,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, any>;
    expect(j.count).toBe(0);
    expect(j.pending).toEqual([]);
    expect(listPendingCustomerAuthorityApprovals.mock.calls[0][0]).toMatchObject({ limit: 10, offset: 20 });
  });
});

describe('POST /admin/customer/:workspace_id/approve', () => {
  function approve(dal: Record<string, unknown>, workspaceId: string) {
    return appFor(dal).request(
      `/api/v1/admin/customer/${workspaceId}/approve`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      {} as never,
    );
  }

  it('404 when the workspace does not exist — recordOperatorAuthority NOT called (no orphaned row)', async () => {
    const dal = {
      workspaceExists: vi.fn(async () => false),
      recordOperatorAuthority: vi.fn(),
      getCustomerAuthorityState: vi.fn(),
    };
    const res = await approve(dal, 'org_typo');
    expect(res.status).toBe(404);
    expect(dal.recordOperatorAuthority).not.toHaveBeenCalled();
    expect(dal.getCustomerAuthorityState).not.toHaveBeenCalled();
  });

  it('200 approves when the workspace exists', async () => {
    const dal = {
      workspaceExists: vi.fn(async () => true),
      recordOperatorAuthority: vi.fn(async () => ({ id: 'cac1' })),
      getCustomerAuthorityState: vi.fn(async () => ({
        workspace_id: 'org_real', unlocked: true, operator_approved: true, consent_acked: true,
        allowed_modes: [], allowed_apps: [], consent: null,
      })),
    };
    const res = await approve(dal, 'org_real');
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, any>;
    expect(j.approved).toBe(true);
    expect(j.authority.unlocked).toBe(true);
    expect(dal.recordOperatorAuthority).toHaveBeenCalledOnce();
    expect(dal.recordOperatorAuthority.mock.calls[0][0]).toMatchObject({ workspace_id: 'org_real' });
  });
});
