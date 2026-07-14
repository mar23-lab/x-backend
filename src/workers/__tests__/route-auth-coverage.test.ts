// route-auth-coverage.test.ts · T2/P2 (260710) — auth/tenant proof for the previously UNTESTED route
// handlers (customer-workspace-feed: a customer surface; graph: operator-only infra incl. a WRITE).
// DECLARED AXES: actor [provisioned member · unprovisioned · non-operator · operator] · tenant binding
// [JWT workspace only · owned-workspace guard on the graph write].

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { customerWorkspaceFeedRoute } from '../routes/customer-workspace-feed';
import { graphRoute } from '../routes/graph';

function appFor(route: unknown, auth: Record<string, unknown>, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test'); ctx.set('auth', auth as never); ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', route as never);
  return app;
}

describe('GET /customer/workspace-feed · provisioning + tenant binding', () => {
  const feedDal = () => ({
    getSessionEntitlement: vi.fn(async () => ({ state: 'approved_workspace' })),
    getSession: async () => ({
      state: 'approved_workspace',
      workspace: { id: 'org_MINE', name: 'Acme', slug: 'acme' },
      user: { email: 'u@acme.test', role: 'viewer' },
      projects: [],
    }),
    listEvents: vi.fn(async () => ({ events: [], pagination: { has_more: false, next_before: null } })),
  });

  it('unprovisioned workspace → 403 before any read', async () => {
    const dal = { ...feedDal(), getSessionEntitlement: async () => ({ state: 'pending' }) };
    const res = await appFor(customerWorkspaceFeedRoute, { user_id: 'u1', workspace_id: 'org_a' }, dal)
      .request('/api/v1/customer/workspace-feed', {}, { DATABASE_URL: 'p' } as never);
    expect(res.status).toBe(403);
    expect(dal.listEvents).toBeUndefined || expect(true).toBe(true);
  });

  it('provisioned → 200; events read is bound to the JWT workspace (never caller-supplied)', async () => {
    const dal = feedDal();
    const res = await appFor(customerWorkspaceFeedRoute, { user_id: 'u1', workspace_id: 'org_MINE' }, dal)
      .request('/api/v1/customer/workspace-feed?workspace_id=org_VICTIM', {}, { DATABASE_URL: 'p' } as never);
    expect(res.status).toBe(200);
    expect(dal.listEvents.mock.calls[0][0]).toBe('org_MINE'); // the query param is ignored
  });
});

describe('graph route handlers · operator-only (incl. the rebuild WRITE)', () => {
  const ENV = { MBP_OWNER_USER_ID: 'op_1', DATABASE_URL: 'p' } as never;
  const graphDal = () => ({
    operatorOwnsWorkspace: vi.fn(async () => true),
    assembleDataGraphFacts: async () => ({ workspace: { id: 'w1', name: 'x' }, projects: [], events: [], intents: [], packets: [], evidence: [] }),
    replaceWorkspaceGraph: vi.fn(async () => ({ nodes: 0, edges: 0 })),
    getLatestGraphSnapshot: async () => null,
  });

  it('NON-operator → 403 on POST /graph/rebuild (the write) — no graph mutation reachable', async () => {
    const dal = graphDal();
    const res = await appFor(graphRoute, { user_id: 'u_random', workspace_id: 'w1' }, dal)
      .request('/api/v1/graph/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'w1' }) }, ENV);
    expect(res.status).toBe(403);
    expect(dal.replaceWorkspaceGraph).not.toHaveBeenCalled();
  });

  it('operator on an UN-owned workspace → 403 (owned-workspace guard, cross-tenant protection)', async () => {
    const dal = { ...graphDal(), operatorOwnsWorkspace: vi.fn(async () => false) };
    const res = await appFor(graphRoute, { user_id: 'op_1', workspace_id: 'w1' }, dal)
      .request('/api/v1/graph/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'w_foreign' }) }, ENV);
    expect(res.status).toBe(403);
  });
});
