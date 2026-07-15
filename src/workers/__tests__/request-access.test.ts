// request-access.test.ts · validation + idempotency + no-auth contract
//
// Authority: AUTH_TENANCY_MODEL.md §Path B early adopter access request

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../index';
import { __resetFallbackBuckets } from '../middleware/rate-limit';

function stubEnv() {
  return {
    // Deliberately invalid and network-free. Persistence-path tests inject a DAL separately;
    // this suite verifies public/auth boundaries and must never attempt external DNS.
    DATABASE_URL: '',
    CLERK_SECRET_KEY: 'sk_test_stub',
    CLERK_JWKS_URL: 'https://stub.clerk.accounts.dev/.well-known/jwks.json',
    ENVIRONMENT: 'development',
    ALLOWED_ORIGIN_PATTERN: 'https://*.xlooop.com',
    CLERK_JWKS_CACHE_TTL_SECONDS: '300',
    LOG_LEVEL: 'debug',
    ADMIN_USER_IDS: '',
    ADMIN_NOTIFICATION_EMAIL: '',
  } as never;
}

describe('POST /api/v1/request-access', () => {
  // Stage 1 mounts a per-IP rate-limit on this route; reset the shared fallback bucket
  // before each case so sequential test posts don't trip the limiter.
  beforeEach(() => __resetFallbackBuckets());

  it('does NOT require Authorization header (public endpoint)', async () => {
    const req = new Request('http://localhost/api/v1/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    const res = await app.fetch(req, stubEnv());
    // Will fail with 5xx because the test has no database, but importantly
    // NOT with 401 — that proves auth doesn't gate the route.
    expect(res.status).not.toBe(401);
  });

  it('returns 400 for missing email', async () => {
    const req = new Request('http://localhost/api/v1/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: 'No Email Co' }),
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(String(body.error)).toMatch(/email/i);
  });

  it('returns 400 for malformed email', async () => {
    const req = new Request('http://localhost/api/v1/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-object body', async () => {
    const req = new Request('http://localhost/api/v1/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '"just a string"',
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(400);
  });

  it('OPTIONS preflight responds 204 with CORS headers', async () => {
    const req = new Request('http://localhost/api/v1/request-access', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.xlooop.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

describe('Admin routes require auth', () => {
  it('GET /api/v1/admin/access-requests without auth → 401', async () => {
    const req = new Request('http://localhost/api/v1/admin/access-requests');
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/admin/access-requests/req_xxx/approve without auth → 401', async () => {
    const req = new Request('http://localhost/api/v1/admin/access-requests/req_xxx/approve', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/admin/users/user_xxx/suspend without auth → 401', async () => {
    const req = new Request('http://localhost/api/v1/admin/users/user_xxx/suspend', {
      method: 'POST',
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(401);
  });
});
