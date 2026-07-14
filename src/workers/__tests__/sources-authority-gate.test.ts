// sources-authority-gate.test.ts · R55 Phase 4a · connector IP-boundary hard-gate
//
// POST /sources/connect/:provider must stay 403 AUTHORITY_REQUIRED for a company workspace until
// its authority + consent record unlocks (CUSTOMER_ECOSYSTEM_ONBOARDING_AND_IP_BOUNDARY_STANDARD).
// Personal (orgless) sessions are NOT gated. The gate returns 403 BEFORE the OAuth adapter runs,
// so the adapter is mocked to throw OAUTH_NOT_CONNECTED (404): a 404 proves the gate was passed,
// a 403 AUTHORITY_REQUIRED proves it blocked. This is the connector side of the same predicate the
// invite gate uses (customer.test.ts) — the most security-critical part of the IP boundary.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../dal/clerk-oauth-adapter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    makeClerkOAuthAdapter: () => ({
      getAccessToken: async () => {
        const e = new Error('not connected') as Error & { code: string };
        e.code = 'OAUTH_NOT_CONNECTED';
        throw e;
      },
    }),
  };
});

import { Hono } from 'hono';
import { sourcesRoute } from '../routes/sources';

const ENV = { CLERK_SECRET_KEY: 'sk_test_x', DATABASE_URL: 'postgres://test' };

function authorityState(unlocked: boolean) {
  return {
    workspace_id: 'org_acme',
    unlocked,
    operator_approved: unlocked,
    consent_acked: unlocked,
    allowed_modes: [],
    allowed_apps: [],
    consent: null,
  };
}

function appFor(auth: Record<string, unknown>, getCustomerAuthorityState?: (ws: string) => Promise<unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', { getCustomerAuthorityState } as never);
    await next();
  });
  app.route('/api/v1', sourcesRoute);
  return app;
}

function connect(app: Hono, provider = 'github') {
  return app.request(`/api/v1/sources/connect/${provider}`, { method: 'POST' }, ENV as never);
}

describe('POST /sources/connect/:provider · IP-boundary authority gate', () => {
  it('401 when unauthenticated', async () => {
    const res = await connect(appFor({}));
    expect(res.status).toBe(401);
  });

  it('400 on an invalid provider (before the gate)', async () => {
    const res = await connect(
      appFor({ user_id: 'u1', workspace_id: 'org_acme' }, async () => authorityState(true)),
      'myspace'
    );
    expect(res.status).toBe(400);
  });

  it('403 AUTHORITY_REQUIRED when the company workspace authority is locked', async () => {
    const getState = vi.fn(async () => authorityState(false));
    const res = await connect(appFor({ user_id: 'u1', workspace_id: 'org_acme' }, getState));
    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(json)).toMatch(/AUTHORITY_REQUIRED/);
    expect(getState).toHaveBeenCalledWith('org_acme');
  });

  it('passes the gate when unlocked (reaches OAuth → 404 OAUTH_NOT_CONNECTED, not 403)', async () => {
    const res = await connect(appFor({ user_id: 'u1', workspace_id: 'org_acme' }, async () => authorityState(true)));
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it('personal (orgless) session is NOT gated — never calls authority state, reaches OAuth (404)', async () => {
    const getState = vi.fn(async () => authorityState(false));
    const res = await connect(appFor({ user_id: 'u1' }, getState));
    expect(res.status).toBe(404);
    expect(getState).not.toHaveBeenCalled();
  });
});
