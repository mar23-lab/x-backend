// recommendations-write-scope.test.ts
//
// R55-3c · Route tests for the recommendation accept/reject TENANT WRITE GUARD.
// Before this fix, accept/reject were gated only by isOperatorContext (role
// 'owner'/'operator' OR MB-P operator) and the DAL updated by id with NO tenant
// scope — so a customer org-admin could accept (→ payload mutation) or reject
// ANOTHER tenant's recommendation by id. The route now resolves the caller's
// tenant scope (recommendationTenantScope) and the DAL enforces it before any
// mutation. This suite emulates that DAL scope guard in the mock.
//
// DAL is mocked via ctx.set (no WorkersDalAdapter import → avoids the pre-existing
// snakecase-keys CJS/ESM collection issue).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { syntheticDomainsRoute } from '../routes/synthetic-domains';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '' };

const RECS: Record<string, { id: string; workspace_id: string | null; status: string; domain_id: string; kind: string }> = {
  recOwned: { id: 'recOwned', workspace_id: 'mbp-private', status: 'pending', domain_id: 'd1', kind: 'note' },
  recCross: { id: 'recCross', workspace_id: null, status: 'pending', domain_id: 'd1', kind: 'note' },
  recCust:  { id: 'recCust',  workspace_id: 'aps-pty-ltd', status: 'pending', domain_id: 'd2', kind: 'note' },
};

function inWriteScope(rec: { workspace_id: string | null }, scope: { workspaceIds: string[]; includeCrossWorkspace: boolean }) {
  if (rec.workspace_id == null) return scope.includeCrossWorkspace === true;
  return scope.workspaceIds.includes(rec.workspace_id);
}

function mockDal() {
  const guard = (id: string, scope?: { workspaceIds: string[]; includeCrossWorkspace: boolean }) => {
    const rec = RECS[id];
    if (!rec) { const e: any = new Error('not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
    if (scope && !inWriteScope(rec, scope)) { const e: any = new Error('not in scope'); e.status = 403; e.code = 'FORBIDDEN'; throw e; }
    return { ...rec, status: 'pending' };
  };
  return {
    // operator owns mbp-private + me
    listWorkspacesForOperator: async (ids: string[]) =>
      ids.includes(MBP_OWNER) ? [{ id: 'mbp-private' }, { id: 'me' }] : [],
    // EMULATE the real DAL scope guard (enforced before any mutation)
    acceptRecommendation: async (id: string, _actor: string, _note: string | undefined, scope?: any) => {
      const rec = guard(id, scope);
      return { ...rec, status: 'accepted' };
    },
    rejectRecommendation: async (id: string, _actor: string, _note: string, scope?: any) => {
      const rec = guard(id, scope);
      return { ...rec, status: 'rejected' };
    },
  };
}

function appFor(auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', mockDal() as never);
    await next();
  });
  app.route('/api/v1', syntheticDomainsRoute);
  return app;
}

const accept = (auth: Record<string, unknown>, id: string) =>
  appFor(auth).request(`/api/v1/synthetic-domain-recommendations/${id}/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'ok' }),
  }, ENV as never);

const reject = (auth: Record<string, unknown>, id: string) =>
  appFor(auth).request(`/api/v1/synthetic-domain-recommendations/${id}/reject`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'no' }),
  }, ENV as never);

const OPERATOR = { user_id: MBP_OWNER, role: 'viewer', workspace_id: '' };       // orgless operator
const CUSTOMER = { user_id: 'user_cust', role: 'operator', workspace_id: 'aps-pty-ltd' }; // customer org-admin
const CLIENT = { user_id: 'user_client', role: 'client', workspace_id: 'aps-pty-ltd' };

describe('POST accept/reject · tenant write guard (R55-3c)', () => {
  it('operator → accept own-workspace rec → 200 accepted', async () => {
    const res = await accept(OPERATOR, 'recOwned');
    expect(res.status).toBe(200);
    expect((await res.json() as any).recommendation.status).toBe('accepted');
  });

  it('operator → accept cross-workspace (null ws) rec → 200', async () => {
    const res = await accept(OPERATOR, 'recCross');
    expect(res.status).toBe(200);
  });

  it('customer → accept ANOTHER tenant rec (mbp-private) → 403 (no cross-tenant write)', async () => {
    const res = await accept(CUSTOMER, 'recOwned');
    expect(res.status).toBe(403);
  });

  it('customer → accept own-workspace rec → 200', async () => {
    const res = await accept(CUSTOMER, 'recCust');
    expect(res.status).toBe(200);
  });

  it('customer → reject ANOTHER tenant rec → 403', async () => {
    const res = await reject(CUSTOMER, 'recOwned');
    expect(res.status).toBe(403);
  });

  it('client role → 403 before the DAL (isOperatorContext gate)', async () => {
    const res = await accept(CLIENT, 'recCust');
    expect(res.status).toBe(403);
  });
});
