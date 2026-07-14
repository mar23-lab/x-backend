// readiness-route.test.ts · M.7 · POST /api/v1/readiness/submit
// The in-app onboarding journey submit: captures the readiness Q&A, then provisions the
// caller's OWN workspace with a roadmap SCALED to the answers. Reuses createAccessRequest +
// approveAccessRequest + createReadinessAssessment + provisionCustomerFromAccessRequest.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Mock the provisioner: we assert it is CALLED with the captured request id for the caller's
// own org. The provisioner's own behavior is covered by onboarding-provisioner tests.
vi.mock('../services/onboarding-provisioner', () => ({
  provisionCustomerFromAccessRequest: vi.fn(async () => ({ ok: true })),
}));
import { provisionCustomerFromAccessRequest } from '../services/onboarding-provisioner';
import { readinessRoute } from '../routes/readiness';

const ENV = { DATABASE_URL: 'x', MBP_OWNER_USER_ID: 'user_owner' };

function appFor(auth: Record<string, unknown> | null, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    if (auth) ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', readinessRoute);
  return app;
}

function dalStub(overrides: Record<string, unknown> = {}) {
  return {
    getSessionEntitlement: async () => ({ state: 'authenticated_no_access' }),
    createAccessRequest: async (input: Record<string, unknown>) => ({ id: 'req_1', ...input, status: 'pending' }),
    approveAccessRequest: async (id: string, by: string) => ({ id, reviewed_by: by, status: 'approved' }),
    createReadinessAssessment: async (input: Record<string, unknown>) => ({ id: 'ra_1', ...input }),
    ...overrides,
  };
}

describe('POST /api/v1/readiness/submit', () => {
  it("captures readiness + provisions the caller's OWN workspace (scaled to the answers)", async () => {
    const cap: { readiness?: Record<string, unknown> } = {};
    const dal = dalStub({
      createReadinessAssessment: async (input: Record<string, unknown>) => { cap.readiness = input; return { id: 'ra_1', ...input }; },
    });
    vi.mocked(provisionCustomerFromAccessRequest).mockClear();
    const app = appFor({ user_id: 'user_1', workspace_id: 'org_abc', email: 'a@honestyoung.example' }, dal);
    const res = await app.request('/api/v1/readiness/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_type: 'company', deep_level: 3, readiness_answers: { q1: 'compliance workpapers', q4: 'Grow' }, domain: 'honestyoung.example' }),
    }, ENV as never);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; state: string };
    expect(out.ok).toBe(true);
    expect(out.state).toBe('approved_workspace');
    // readiness captured against the new request id, carrying the answers + level
    expect(cap.readiness?.access_request_id).toBe('req_1');
    expect(cap.readiness?.deep_level).toBe(3);
    expect(cap.readiness?.readiness_answers).toMatchObject({ q1: 'compliance workpapers', q4: 'Grow' });
    // provisioned the SAME request for the caller's OWN org (never another tenant)
    expect(provisionCustomerFromAccessRequest).toHaveBeenCalledTimes(1);
    const provArg = (vi.mocked(provisionCustomerFromAccessRequest).mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(provArg.accessRequestId).toBe('req_1');
    expect(provArg.clerkOrgId).toBe('org_abc');
    expect(provArg.ownerClerkId).toBe('user_1');
  });

  it('is idempotent: an already-provisioned caller returns already=true with no writes', async () => {
    const cap = { created: 0 };
    const dal = dalStub({
      getSessionEntitlement: async () => ({ state: 'approved_workspace' }),
      createAccessRequest: async (input: Record<string, unknown>) => { cap.created++; return { id: 'req_x', ...input }; },
    });
    vi.mocked(provisionCustomerFromAccessRequest).mockClear();
    const app = appFor({ user_id: 'user_1', workspace_id: 'org_abc', email: 'a@honestyoung.example' }, dal);
    const res = await app.request('/api/v1/readiness/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, ENV as never);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { already?: boolean };
    expect(out.already).toBe(true);
    expect(cap.created).toBe(0);
    expect(provisionCustomerFromAccessRequest).not.toHaveBeenCalled();
  });

  it('E2 re-entry: reprovision:true + CUSTOMER_SELF_SERVICE_ENABLED on → re-provisions (skips the short-circuit)', async () => {
    const dal = dalStub({ getSessionEntitlement: async () => ({ state: 'approved_workspace' }) });
    vi.mocked(provisionCustomerFromAccessRequest).mockClear();
    const app = appFor({ user_id: 'user_1', workspace_id: 'org_abc', email: 'a@honestyoung.example' }, dal);
    const res = await app.request('/api/v1/readiness/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reprovision: true, deep_level: 4, readiness_answers: { q1: 'updated goal' } }),
    }, { ...ENV, CUSTOMER_SELF_SERVICE_ENABLED: 'true' } as never);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { already?: boolean; state?: string };
    expect(out.already).toBeUndefined();                                 // did NOT short-circuit
    expect(provisionCustomerFromAccessRequest).toHaveBeenCalledTimes(1); // re-provisioned (roadmap refreshed, status-preserving via F1)
  });

  it('E2 re-entry is flag-gated: reprovision:true but CUSTOMER_SELF_SERVICE_ENABLED off → still short-circuits', async () => {
    const dal = dalStub({ getSessionEntitlement: async () => ({ state: 'approved_workspace' }) });
    vi.mocked(provisionCustomerFromAccessRequest).mockClear();
    const app = appFor({ user_id: 'user_1', workspace_id: 'org_abc', email: 'a@honestyoung.example' }, dal);
    const res = await app.request('/api/v1/readiness/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reprovision: true }),
    }, ENV as never); // CUSTOMER_SELF_SERVICE_ENABLED unset → off → reprovision ignored
    expect(res.status).toBe(200);
    const out = (await res.json()) as { already?: boolean };
    expect(out.already).toBe(true);                                      // short-circuited (flag gates re-entry)
    expect(provisionCustomerFromAccessRequest).not.toHaveBeenCalled();
  });

  it('is 401 without auth', async () => {
    const res = await appFor(null, dalStub()).request('/api/v1/readiness/submit', { method: 'POST', body: '{}' }, ENV as never);
    expect(res.status).toBe(401);
  });

  it('is 403 when the session has no org', async () => {
    const res = await appFor({ user_id: 'user_1', email: 'a@b.example' }, dalStub()).request('/api/v1/readiness/submit', { method: 'POST', body: '{}' }, ENV as never);
    expect(res.status).toBe(403);
  });

  it('still provisions when readiness persistence fails (best-effort, never strands the user)', async () => {
    const dal = dalStub({ createReadinessAssessment: async () => { throw new Error('readiness_assessments unavailable'); } });
    vi.mocked(provisionCustomerFromAccessRequest).mockClear();
    const app = appFor({ user_id: 'user_1', workspace_id: 'org_abc', email: 'a@b.example' }, dal);
    const res = await app.request('/api/v1/readiness/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deep_level: 2 }) }, ENV as never);
    expect(res.status).toBe(200);
    expect(provisionCustomerFromAccessRequest).toHaveBeenCalledTimes(1);
  });
});
