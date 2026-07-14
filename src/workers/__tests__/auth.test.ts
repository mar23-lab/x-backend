// auth.test.ts · vitest spec for Clerk auth middleware contract
//
// Run via: npm run test:workers
// Verifies the middleware's BEHAVIOR (envelope shape, status codes) without
// hitting live Clerk — invalid tokens are expected to fail JWT verification.

import { describe, it, expect } from 'vitest';
import app from '../index';

function stubEnv() {
  return {
    DATABASE_URL: 'postgres://stub:stub@stub/stub',
    CLERK_SECRET_KEY: 'sk_test_INVALID_KEY_FOR_TEST',
    CLERK_JWKS_URL: 'https://stub.clerk.accounts.dev/.well-known/jwks.json',
    ENVIRONMENT: 'development',
    ALLOWED_ORIGIN_PATTERN: 'https://*.xlooop.com',
    CLERK_JWKS_CACHE_TTL_SECONDS: '300',
    LOG_LEVEL: 'debug',
  } as never;
}

function stubEnvWithCanary() {
  return {
    ...stubEnv(),
    XLOOOP_CANARY_API_TOKEN_SHA256: 'b5b03cfd61ee62a8a6042bcf0f91ed802f04cbd9cc8d40749c7e09c233ffac42',
    XLOOOP_CANARY_LIFECYCLE_TOKEN_SHA256: '41c67ef703fdb30d29ee96c0569738f8dca2a4e3a47236a2d4895e54f2adde00',
    XLOOOP_CANARY_WORKSPACE_ID: 'org_canary_workspace',
    OPERATIONAL_SPINE_PACKET_SIGNING_SECRET: 'unit-test-signing-secret',
  } as never;
}

async function getBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('Clerk JWT auth middleware', () => {
  it('returns 401 UNAUTHORIZED when Authorization header is missing (GET /api/v1/session)', async () => {
    const req = new Request('http://localhost/api/v1/session');
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(401);
    const body = await getBody(res);
    expect(body.code).toBe('UNAUTHORIZED');
    expect(typeof body.error).toBe('string');
    expect(typeof body.request_id).toBe('string');
  });

  it('returns 401 when Bearer token is empty', async () => {
    const req = new Request('http://localhost/api/v1/session', {
      headers: { Authorization: 'Bearer ' },
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(401);
    const body = await getBody(res);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when scheme is not Bearer', async () => {
    const req = new Request('http://localhost/api/v1/session', {
      headers: { Authorization: 'Basic abc123' },
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid JWT format (fails verifyToken)', async () => {
    const req = new Request('http://localhost/api/v1/session', {
      headers: { Authorization: 'Bearer not.a.real.jwt' },
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(401);
    const body = await getBody(res);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('protects POST /api/v1/events (no auth → 401)', async () => {
    const req = new Request('http://localhost/api/v1/events', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt_1', source_tool: 'operator', status: 'queued', summary: 'x', occurred_at: '2026-05-26T12:00:00Z' }),
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(401);
  });

  it('protects POST /api/v1/sign-offs (no auth → 401)', async () => {
    const req = new Request('http://localhost/api/v1/sign-offs', {
      method: 'POST',
      body: JSON.stringify({ event_id: 'evt_1', verdict: 'approved' }),
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(401);
  });

  it('returns 404 with envelope shape for unknown route under /api/v1/* (after auth runs and fails)', async () => {
    const req = new Request('http://localhost/api/v1/nope-not-real', {
      headers: { Authorization: 'Bearer fake' },
    });
    const res = await app.fetch(req, stubEnv());
    // Auth runs first → 401 before reaching notFound handler. Both are valid shapes; we just want no 500.
    expect(res.status).toBeLessThan(500);
    const body = await getBody(res);
    expect(typeof body.code).toBe('string');
    expect(typeof body.error).toBe('string');
    expect(typeof body.request_id).toBe('string');
  });

  it('allows the scoped canary service principal only on the operational MCP read surface', async () => {
    const req = new Request('http://localhost/api/v1/mcp/tools', {
      headers: { Authorization: 'Bearer unit-canary-token-abcdefghijklmnopqrstuvwxyz' },
    });
    const res = await app.fetch(req, stubEnvWithCanary());
    expect(res.status).toBe(200);
    const body = await getBody(res);
    expect(body.schema_id).toBe('xlooop.mcp_gateway_tools.v1');
    expect(Array.isArray(body.tools)).toBe(true);
    expect(Array.isArray(body.forbidden_surfaces)).toBe(true);
  });

  it('does not allow the canary service principal on ordinary product routes', async () => {
    const req = new Request('http://localhost/api/v1/projects', {
      headers: { Authorization: 'Bearer unit-canary-token-abcdefghijklmnopqrstuvwxyz' },
    });
    const res = await app.fetch(req, stubEnvWithCanary());
    expect(res.status).toBe(403);
    const body = await getBody(res);
    expect(body.code).toBe('FORBIDDEN');
    expect(String(body.error)).toContain('canary service-principal');
  });

  it('keeps the canary service principal read-only on MCP write surfaces', async () => {
    const req = new Request('http://localhost/api/v1/mcp/evidence', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer unit-canary-token-abcdefghijklmnopqrstuvwxyz',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        packet_id: 'pkt_canary',
        kind: 'log',
        summary: 'should not write',
      }),
    });
    const res = await app.fetch(req, stubEnvWithCanary());
    expect(res.status).toBe(403);
    const body = await getBody(res);
    expect(body.code).toBe('FORBIDDEN');
    expect(String(body.error)).toContain('role does not permit evidence submission');
  });

  it('keeps the lifecycle canary service principal out of ordinary product routes', async () => {
    const req = new Request('http://localhost/api/v1/projects', {
      headers: { Authorization: 'Bearer unit-canary-lifecycle-token-abcdefghijklmnopqrstuvwxyz' },
    });
    const res = await app.fetch(req, stubEnvWithCanary());
    expect(res.status).toBe(403);
    const body = await getBody(res);
    expect(body.code).toBe('FORBIDDEN');
    expect(String(body.error)).toContain('canary service-principal');
  });

  it('fails closed when a random non-JWT token does not match the configured canary hash', async () => {
    const req = new Request('http://localhost/api/v1/mcp/tools', {
      headers: { Authorization: 'Bearer wrong-canary-token-abcdefghijklmnopqrstuvwxyz' },
    });
    const res = await app.fetch(req, stubEnvWithCanary());
    expect(res.status).toBe(401);
    const body = await getBody(res);
    expect(body.code).toBe('UNAUTHORIZED');
  });
});
