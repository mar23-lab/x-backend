// mbp-projection-diagnose-route.test.ts · R5 (260710-B) · boundary coverage for two operator/infra routes.
// mbp-projection serves the OPERATOR's real MB-P data — DECLARED AXES: config [MBP_OWNER_USER_ID unset →
// 503] · auth [missing bearer → 401 · non-owner JWT → 403 · owner → 200]. diagnose is a PUBLIC triage
// endpoint — DECLARED AXES: validation [bad user_id format → 400] · characterization [reachable WITHOUT
// auth — this test PINS that deliberate exposure so a future reader knows it is not auth-gated].

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Mock the Clerk verifier so we can drive the owner-match branch deterministically.
vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'owner-token') return { sub: 'user_OWNER' };
    if (token === 'stranger-token') return { sub: 'user_STRANGER' };
    throw new Error('bad token');
  }),
}));

import { mbpProjectionRoute } from '../routes/mbp-projection';
import { diagnoseRoute } from '../routes/diagnose';

function appFor(route: unknown, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('request_id', 't'); ctx.set('dal', dal as never); await next(); });
  app.route('/api/v1', route as never);
  return app;
}
const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

describe('GET /mbp-projection · operator-only (serves real MB-P data)', () => {
  const ENV_OK = { MBP_OWNER_USER_ID: 'user_OWNER', CLERK_SECRET_KEY: 'sk' } as never;

  it('MBP_OWNER_USER_ID unset → 503 (fail-closed config guard)', async () => {
    const res = await appFor(mbpProjectionRoute, {}).request('/api/v1/mbp-projection', bearer('owner-token'), { CLERK_SECRET_KEY: 'sk' } as never);
    expect(res.status).toBe(503);
  });

  it('missing bearer → 401', async () => {
    const res = await appFor(mbpProjectionRoute, {}).request('/api/v1/mbp-projection', {}, ENV_OK);
    expect(res.status).toBe(401);
  });

  it('valid JWT but NOT the owner → 403 (no MB-P data leaks to a non-operator)', async () => {
    const res = await appFor(mbpProjectionRoute, {}).request('/api/v1/mbp-projection', bearer('stranger-token'), ENV_OK);
    expect(res.status).toBe(403);
  });

  it('the configured owner → 200 with the projection envelope', async () => {
    const res = await appFor(mbpProjectionRoute, {}).request('/api/v1/mbp-projection', bearer('owner-token'), ENV_OK);
    expect(res.status).toBe(200);
    const body = await res.json() as { _meta: { authority: string; requester: string } };
    expect(body._meta.authority).toBe('r43_7_authenticated_mbp_owner_only');
    expect(body._meta.requester).toBe('user_OWNER');
  });
});

describe('GET /diagnose-user/:user_id · OPERATOR-GATED (260710 sec-review — was public)', () => {
  const dalStub = () => ({ sql: vi.fn(async () => []) });
  const ENV_OK = { DATABASE_URL: 'p', MBP_OWNER_USER_ID: 'user_OWNER', CLERK_SECRET_KEY: 'sk' } as never;

  it('MBP_OWNER_USER_ID unset → 503 (fail-closed config guard)', async () => {
    const res = await appFor(diagnoseRoute, dalStub()).request('/api/v1/diagnose-user/user_abc123', bearer('owner-token'), { DATABASE_URL: 'p', CLERK_SECRET_KEY: 'sk' } as never);
    expect(res.status).toBe(503);
  });

  it('no bearer token → 401 (the exposure is closed: no is_admin/workspace-name leak without auth)', async () => {
    const res = await appFor(diagnoseRoute, dalStub()).request('/api/v1/diagnose-user/user_abc123', {}, ENV_OK);
    expect(res.status).toBe(401);
  });

  it('valid JWT but NOT the operator → 403', async () => {
    const res = await appFor(diagnoseRoute, dalStub()).request('/api/v1/diagnose-user/user_abc123', bearer('stranger-token'), ENV_OK);
    expect(res.status).toBe(403);
  });

  it('operator token → passes the gate; then rejects a malformed user_id → 400', async () => {
    const res = await appFor(diagnoseRoute, dalStub()).request('/api/v1/diagnose-user/not-a-user-id', bearer('owner-token'), ENV_OK);
    expect(res.status).toBe(400); // past the gate, into validation
  });

  it('operator token + valid user_id → runs the query path (200/404/500, never an auth code)', async () => {
    const res = await appFor(diagnoseRoute, dalStub()).request('/api/v1/diagnose-user/user_abc123', bearer('owner-token'), ENV_OK);
    expect([200, 404, 500]).toContain(res.status);
    expect([401, 403]).not.toContain(res.status);
  });
});
