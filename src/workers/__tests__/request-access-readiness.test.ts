// request-access-readiness.test.ts - R55 Phase 2/4b - readiness payload persistence
//
// The public access-request route persists the readiness funnel Q&A (account_type, answers,
// deep_level, enrichment) into readiness_assessments when the extended payload is present, and
// skips it for a bare {email} request. Best-effort: a persistence failure must never block the 202.
//
// Mounts requestAccessRoute directly with an injected mock DAL (the full-app test in
// request-access.test.ts can only reach validation because its stub DATABASE_URL cannot connect).

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { requestAccessRoute } from '../routes/request-access';

const ENV = { DATABASE_URL: 'postgres://test', ADMIN_NOTIFICATION_EMAIL: '', ENVIRONMENT: 'test' };

function appWith(dal: Record<string, unknown>) {
  // Part R Stage B added a registered-vs-anonymous lookup to the route; a mock without
  // getUserByEmail throws a SYNC TypeError that the route's promise .catch can't absorb → 500.
  const fullDal = { getUserByEmail: async () => null, ...dal };
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test-req');
    ctx.set('dal', fullDal as never);
    await next();
  });
  app.route('/api/v1', requestAccessRoute);
  return app;
}

function accessRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req_1',
    email: 'e@acme.com',
    company_name: null,
    reason: null,
    source: 'web',
    status: 'pending',
    ip_address: null,
    user_agent: null,
    created_at: '2026-06-07T00:00:00Z',
    updated_at: '2026-06-07T00:00:00Z',
    ...overrides,
  };
}

function post(app: Hono, body: unknown) {
  return app.request(
    '/api/v1/request-access',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ENV as never
  );
}

describe('POST /request-access - readiness persistence', () => {
  it('bare {email} request does NOT create a readiness assessment', async () => {
    const createAccessRequest = vi.fn(async () => accessRequestRow());
    const createReadinessAssessment = vi.fn();
    const res = await post(appWith({ createAccessRequest, createReadinessAssessment }), { email: 'e@acme.com' });
    expect(res.status).toBe(202);
    expect(createAccessRequest).toHaveBeenCalledOnce();
    expect(createReadinessAssessment).not.toHaveBeenCalled();
  });

  it('extended payload (account_type + answers + level) persists a readiness assessment', async () => {
    const createAccessRequest = vi.fn(async () => accessRequestRow({ company_name: 'Acme' }));
    const createReadinessAssessment = vi.fn(async () => ({ id: 'ra_1' }));
    const res = await post(appWith({ createAccessRequest, createReadinessAssessment }), {
      email: 'e@acme.com',
      company_name: 'Acme',
      account_type: 'company',
      readiness_answers: { q1: 'a' },
      deep_level: 3,
      domain: 'acme.com',
    });
    expect(res.status).toBe(202);
    expect(createReadinessAssessment).toHaveBeenCalledOnce();
    const arg = createReadinessAssessment.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.access_request_id).toBe('req_1');
    expect(arg.account_type).toBe('company');
    expect(arg.deep_level).toBe(3);
    expect(arg.readiness_answers).toEqual({ q1: 'a' });
  });

  it('invalid account_type falls back to company when other readiness signals are present', async () => {
    const createReadinessAssessment = vi.fn(async () => ({ id: 'ra_1' }));
    const res = await post(
      appWith({ createAccessRequest: vi.fn(async () => accessRequestRow()), createReadinessAssessment }),
      { email: 'e@acme.com', account_type: 'bogus', deep_level: 1 }
    );
    expect(res.status).toBe(202);
    expect(createReadinessAssessment).toHaveBeenCalledOnce();
    expect((createReadinessAssessment.mock.calls[0][0] as Record<string, unknown>).account_type).toBe('company');
  });

  it('readiness persistence failure does NOT block the 202 (best-effort)', async () => {
    const createReadinessAssessment = vi.fn(async () => {
      throw new Error('db down');
    });
    const res = await post(
      appWith({ createAccessRequest: vi.fn(async () => accessRequestRow()), createReadinessAssessment }),
      { email: 'e@acme.com', account_type: 'both' }
    );
    expect(res.status).toBe(202);
    expect(createReadinessAssessment).toHaveBeenCalled();
  });
});
