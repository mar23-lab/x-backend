// readiness-route.test.ts · authenticated onboarding persistence and provisioning

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const readinessStore = vi.hoisted(() => ({
  getByWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
}));

vi.mock('../db/client', () => ({
  neonClient: vi.fn(() => vi.fn()),
}));
vi.mock('../dal/customer-readiness-store', () => ({
  getReadinessAssessmentByWorkspaceRow: readinessStore.getByWorkspace,
  saveWorkspaceReadinessAssessmentRow: readinessStore.saveWorkspace,
}));
vi.mock('../services/onboarding-provisioner', () => ({
  provisionCustomerFromAccessRequest: vi.fn(async () => ({ ok: true })),
}));

import { provisionCustomerFromAccessRequest } from '../services/onboarding-provisioner';
import { readinessRoute } from '../routes/readiness';

const ENV = { DATABASE_URL: 'x', MBP_OWNER_USER_ID: 'user_owner' };
const AUTH = {
  user_id: 'user_1',
  workspace_id: 'org_abc',
  email: 'a@honestyoung.example',
};

function savedReadiness(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ra_1',
    access_request_id: 'req_1',
    user_id: 'user_1',
    workspace_id: 'org_abc',
    email: 'a@honestyoung.example',
    account_type: 'company',
    also_personal_space: false,
    company_name: 'Honest Young',
    domain: 'honestyoung.example',
    country: 'AU',
    deep_level: 3,
    readiness_answers: { focus_90d: 'compliance workpapers', business_direction: 'Grow' },
    deep_check: null,
    enrichment: null,
    consent: {},
    source: 'inapp-readiness-profile',
    metadata: {},
    created_at: '2026-07-24T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:01.000Z',
    readiness_revision_id: 'readiness:ra_1:audit_1',
    audit_event_id: 'audit_1',
    replayed: false,
    request_digest: 'a'.repeat(64),
    ...overrides,
  };
}

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
    getSessionEntitlement: vi.fn(async () => ({ state: 'authenticated_no_access' })),
    createAccessRequest: vi.fn(async (input: Record<string, unknown>) => ({
      id: 'req_1',
      ...input,
      status: 'pending',
    })),
    approveAccessRequest: vi.fn(async (id: string, by: string) => ({
      id,
      reviewed_by: by,
      status: 'approved',
    })),
    createReadinessAssessment: vi.fn(async (input: Record<string, unknown>) => ({
      id: 'ra_1',
      ...input,
    })),
    ...overrides,
  };
}

function submit(
  app: Hono,
  body: Record<string, unknown> = {},
  env: Record<string, unknown> = ENV,
  idempotencyKey = 'onboarding-save-1',
) {
  return app.request('/api/v1/readiness/submit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  }, env as never);
}

beforeEach(() => {
  vi.mocked(provisionCustomerFromAccessRequest).mockClear();
  readinessStore.getByWorkspace.mockReset();
  readinessStore.getByWorkspace.mockResolvedValue(null);
  readinessStore.saveWorkspace.mockReset();
  readinessStore.saveWorkspace.mockImplementation(async (_sql, input) => savedReadiness({
    workspace_id: input.workspace_id,
    user_id: input.user_id,
    email: input.email,
    company_name: input.company_name,
    domain: input.domain,
    readiness_answers: input.readiness_answers,
    request_digest: input.request_digest,
  }));
});

describe('POST /api/v1/readiness/submit', () => {
  it("persists readiness, provisions the caller's workspace, and returns a durable receipt", async () => {
    const dal = dalStub();
    const app = appFor(AUTH, dal);
    const res = await submit(app, {
      account_type: 'company',
      deep_level: 3,
      readiness_answers: {
        focus_90d: 'compliance workpapers',
        business_direction: 'Grow',
      },
      domain: 'honestyoung.example',
    });

    expect(res.status).toBe(200);
    const out = await res.json() as {
      receipt_id: string;
      audit_event_id: string;
      readiness: { has_readiness: boolean };
    };
    expect(out.receipt_id).toBe('readiness:ra_1:audit_1');
    expect(out.audit_event_id).toBe('audit_1');
    expect(out.readiness.has_readiness).toBe(true);
    expect(dal.createReadinessAssessment).toHaveBeenCalledWith(expect.objectContaining({
      access_request_id: 'req_1',
      deep_level: 3,
      readiness_answers: expect.objectContaining({ business_direction: 'Grow' }),
    }));
    expect(provisionCustomerFromAccessRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provisionCustomerFromAccessRequest).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        accessRequestId: 'req_1',
        clerkOrgId: 'org_abc',
        ownerClerkId: 'user_1',
      }),
    );
    expect(readinessStore.saveWorkspace).toHaveBeenCalledTimes(1);
  });

  it('updates an already-provisioned workspace instead of returning a false no-op success', async () => {
    const dal = dalStub({
      getSessionEntitlement: vi.fn(async () => ({ state: 'approved_workspace' })),
    });
    const res = await submit(appFor(AUTH, dal), {
      readiness_answers: { focus_90d: 'new customer baseline' },
    });

    expect(res.status).toBe(200);
    const out = await res.json() as {
      workspace_already_provisioned: boolean;
      receipt_id: string;
    };
    expect(out.workspace_already_provisioned).toBe(true);
    expect(out.receipt_id).toBe('readiness:ra_1:audit_1');
    expect(dal.createAccessRequest).not.toHaveBeenCalled();
    expect(readinessStore.saveWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspace_id: 'org_abc',
        client_request_id: 'onboarding-save-1',
        readiness_answers: { focus_90d: 'new customer baseline' },
      }),
    );
    expect(provisionCustomerFromAccessRequest).not.toHaveBeenCalled();
  });

  it('replays the same client request receipt without provisioning', async () => {
    const dal = dalStub({
      getSessionEntitlement: vi.fn(async () => ({ state: 'approved_workspace' })),
    });
    readinessStore.saveWorkspace.mockResolvedValue(savedReadiness({ replayed: true }));

    const res = await submit(appFor(AUTH, dal), {}, ENV, 'same-request');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({
      replayed: true,
      receipt_id: 'readiness:ra_1:audit_1',
    }));
    expect(provisionCustomerFromAccessRequest).not.toHaveBeenCalled();
  });

  it('reprovisions only when the customer self-service flag is enabled', async () => {
    const dal = dalStub({
      getSessionEntitlement: vi.fn(async () => ({ state: 'approved_workspace' })),
    });
    const res = await submit(
      appFor(AUTH, dal),
      { reprovision: true, readiness_answers: { focus_90d: 'updated goal' } },
      { ...ENV, CUSTOMER_SELF_SERVICE_ENABLED: 'true' },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({
      workspace_already_provisioned: true,
      roadmap_refreshed: true,
    }));
    expect(provisionCustomerFromAccessRequest).toHaveBeenCalledTimes(1);
  });

  it('ignores reprovision when the feature flag is off but still saves the baseline', async () => {
    const dal = dalStub({
      getSessionEntitlement: vi.fn(async () => ({ state: 'approved_workspace' })),
    });
    const res = await submit(appFor(AUTH, dal), { reprovision: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({
      workspace_already_provisioned: true,
      roadmap_refreshed: false,
    }));
    expect(readinessStore.saveWorkspace).toHaveBeenCalledTimes(1);
    expect(provisionCustomerFromAccessRequest).not.toHaveBeenCalled();
  });

  it('fails closed before provisioning when the initial readiness write fails', async () => {
    const dal = dalStub({
      createReadinessAssessment: vi.fn(async () => {
        throw new Error('readiness_assessments unavailable');
      }),
    });
    const res = await submit(appFor(AUTH, dal), { deep_level: 2 });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      error: 'internal error',
    }));
    expect(provisionCustomerFromAccessRequest).not.toHaveBeenCalled();
    expect(readinessStore.saveWorkspace).not.toHaveBeenCalled();
  });

  it('fails closed when the durable receipt cannot be produced', async () => {
    const dal = dalStub({
      getSessionEntitlement: vi.fn(async () => ({ state: 'approved_workspace' })),
    });
    readinessStore.saveWorkspace.mockRejectedValue(new Error('audit unavailable'));
    const res = await submit(appFor(AUTH, dal));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      error: 'internal error',
    }));
  });

  it('requires an idempotency key', async () => {
    const app = appFor(AUTH, dalStub());
    const res = await app.request('/api/v1/readiness/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, ENV as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    }));
  });

  it('is 401 without auth', async () => {
    const res = await submit(appFor(null, dalStub()));
    expect(res.status).toBe(401);
  });

  it('is 403 when the session has no org', async () => {
    const res = await submit(appFor({ user_id: 'user_1', email: 'a@b.example' }, dalStub()));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/readiness', () => {
  it('returns the canonical saved prefill and immutable revision', async () => {
    readinessStore.getByWorkspace.mockResolvedValue(savedReadiness());
    const res = await appFor(AUTH, dalStub()).request('/api/v1/readiness', {}, ENV as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({
      schema_id: 'xlooop.readiness_prefill.v1',
      has_readiness: true,
      readiness_revision_id: 'readiness:ra_1:2026-07-24T00:00:01.000Z',
      readiness_answers: expect.objectContaining({ business_direction: 'Grow' }),
    }));
    expect(readinessStore.getByWorkspace).toHaveBeenCalledWith(expect.anything(), 'org_abc');
  });

  it('returns not-started only after a successful empty lookup', async () => {
    readinessStore.getByWorkspace.mockResolvedValue(null);
    const res = await appFor(AUTH, dalStub()).request('/api/v1/readiness', {}, ENV as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schema_id: 'xlooop.readiness_prefill.v1',
      has_readiness: false,
    });
  });

  it('does not disguise a database failure as not-started', async () => {
    readinessStore.getByWorkspace.mockRejectedValue(new Error('database unavailable'));
    const res = await appFor(AUTH, dalStub()).request('/api/v1/readiness', {}, ENV as never);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      error: 'internal error',
    }));
  });
});
