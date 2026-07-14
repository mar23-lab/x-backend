// synthetic-domains-recommendations.test.ts · audit 260531
//
// Route tests for the recommendations auth + tenant scoping fix. Closes two gaps:
//   1. orgless-403 — the default operator runs a personal (orgless) Clerk session;
//      the route is now org-OPTIONAL and recognizes the operator by stable user_id.
//   2. unscoped cross-tenant read — GET /recommendations now scopes to the caller's
//      tenant; an unscoped caller gets NOTHING (fail-closed).
//
// Mocks the DAL (the mock EMULATES the real listRecommendations scoping contract) so
// the test asserts the ROUTE computes + passes the right scope end-to-end, and so the
// suite COLLECTS without pulling the snakecase-keys CJS/ESM chain that breaks the
// WorkersDalAdapter-importing suites.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { syntheticDomainsRoute } from '../routes/synthetic-domains';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '' };

// Recommendations across tenants: operator workspaces, cross-workspace (NULL), customer.
const ALL_RECS = [
  { id: 'r1', workspace_id: 'mbp-private', status: 'pending' },
  { id: 'r2', workspace_id: 'me', status: 'pending' },
  { id: 'r3', workspace_id: null, status: 'pending' }, // cross-workspace · operator-only
  { id: 'r4', workspace_id: 'aps-pty-ltd', status: 'pending' }, // customer tenant
];

function mockDal() {
  return {
    // operator owns mbp-private + me; nobody else owns anything
    listWorkspacesForOperator: async (ids: string[]) =>
      ids.includes(MBP_OWNER) ? [{ id: 'mbp-private' }, { id: 'me' }] : [],
    getSyntheticDomain: async () => ({ id: 'd1', workspace_id: 'mbp-private' }),
    createSyntheticDomain: async () => ({ id: 'new', workspace_id: 'mbp-private' }),
    // EMULATES the real WorkersDalAdapter.listRecommendations scoping + fail-closed
    listRecommendations: async (opts: any) => {
      const status = opts.status ?? 'pending';
      if (opts.domain_id) return ALL_RECS.filter((r) => r.status === status);
      const wsIds: string[] = Array.isArray(opts.workspaceIds) ? opts.workspaceIds.filter(Boolean) : [];
      const cross = opts.includeCrossWorkspace === true;
      if (wsIds.length === 0 && !cross) return []; // fail-closed: no scope → no rows
      return ALL_RECS.filter(
        (r) =>
          r.status === status &&
          ((r.workspace_id != null && wsIds.includes(r.workspace_id)) || (r.workspace_id == null && cross)),
      );
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

const get = (auth: Record<string, unknown>, path = '/api/v1/recommendations') =>
  appFor(auth).request(path, {}, ENV as never);

describe('GET /recommendations · tenant scoping (audit 260531)', () => {
  it('orgless MB-P operator → their workspaces + cross-workspace, NOT customer rows', async () => {
    const res = await get({ user_id: MBP_OWNER, role: 'viewer', workspace_id: '' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.recommendations.map((r: any) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('customer → ONLY their own workspace (no cross, no operator rows)', async () => {
    const res = await get({ user_id: 'user_customer', role: 'operator', workspace_id: 'aps-pty-ltd' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.recommendations.map((r: any) => r.id)).toEqual(['r4']);
  });

  it('client role → 403', async () => {
    const res = await get({ user_id: 'user_client', role: 'client', workspace_id: 'aps-pty-ltd' });
    expect(res.status).toBe(403);
  });

  it('orgless NON-operator → 200 but EMPTY (fail-closed: no workspace, not operator)', async () => {
    const res = await get({ user_id: 'user_random', role: 'viewer', workspace_id: '' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.recommendations).toEqual([]);
  });
});

describe('synthetic-domain writes · stay operator-gated', () => {
  const post = (auth: Record<string, unknown>) =>
    appFor(auth).request(
      '/api/v1/synthetic-domains',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'x', label: 'X', binding: {} }) },
      ENV as never,
    );

  it('orgless MB-P operator CAN write (gate passes — not 403)', async () => {
    const res = await post({ user_id: MBP_OWNER, role: 'viewer', workspace_id: '' });
    expect(res.status).not.toBe(403);
  });

  it('client CANNOT write (403)', async () => {
    const res = await post({ user_id: 'user_client', role: 'client', workspace_id: 'aps-pty-ltd' });
    expect(res.status).toBe(403);
  });
});
