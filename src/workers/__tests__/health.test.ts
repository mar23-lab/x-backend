// health.test.ts · vitest spec for GET /api/v1/health
//
// Run via: npm run test:workers
// Uses @cloudflare/vitest-pool-workers · executes inside workerd runtime.

import { describe, it, expect } from 'vitest';
import app from '../index';

function stubEnv() {
  return {
    DATABASE_URL: 'postgres://stub:stub@stub/stub',
    CLERK_SECRET_KEY: 'sk_test_stub',
    CLERK_JWKS_URL: 'https://stub.clerk.accounts.dev/.well-known/jwks.json',
    ENVIRONMENT: 'development',
    ALLOWED_ORIGIN_PATTERN: 'https://*.xlooop.com',
    CLERK_JWKS_CACHE_TTL_SECONDS: '300',
    LOG_LEVEL: 'debug',
  } as never;
}

describe('GET /api/v1/health', () => {
  it('returns 200 with {status, version, timestamp}', async () => {
    const req = new Request('http://localhost/api/v1/health');
    const res = await app.fetch(req, stubEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.timestamp).toBe('string');
    expect(body.contract_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.authority).toBe('shadow');
    expect(body.environment).toBe('development');
    expect(body.schema_head).toBeNull();
    // Timestamp must be ISO 8601
    expect(() => new Date(body.timestamp as string).toISOString()).not.toThrow();
  });

  it('reports pilot-shadow feature and binding posture without claiming authority', async () => {
    const env = {
      ...(stubEnv() as unknown as Record<string, unknown>),
      ENVIRONMENT: 'pilot-shadow',
      XLOOOP_SCHEMA_HEAD: '079',
      XLOOOP_AUTHORITY_MODE: 'shadow',
      SINGLE_INTAKE_ENABLED: 'true',
      ROLE_SKILL_CATALOG_ENABLED: 'true',
      CONTEXT_PACKET_PERSISTENCE_ENABLED: 'true',
      TENANT_PROJECTION_QUEUE_ENABLED: 'true',
      CURRENT_WORK_PROJECTION_ENABLED: 'true',
      TENANT_PROJECTION_QUEUE: { send: async () => undefined },
    } as never;
    const res = await app.fetch(new Request('http://localhost/api/v1/health'), env);
    const body = (await res.json()) as any;
    expect(body.environment).toBe('pilot-shadow');
    expect(body.authority).toBe('shadow');
    expect(body.schema_head).toBe('079');
    expect(body.feature_posture).toEqual({
      single_intake: true,
      role_skill_catalog: true,
      context_packet_persistence: true,
      tenant_projection_queue: true,
      current_work_projection: true,
    });
    expect(body.bindings.tenant_projection_queue).toBe(true);
  });

  it('exposes a REAL deploy signal: build / built_at injected at deploy (HR-CONFIG-REALITY-MATCH-1)', async () => {
    const env = {
      ...(stubEnv() as unknown as Record<string, unknown>),
      BUILD_SHA: 'abc1234',
      BUILD_TIME: '20260607T160244Z',
    } as never;
    const req = new Request('http://localhost/api/v1/health');
    const res = await app.fetch(req, env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.build).toBe('abc1234'); // CHANGES per deploy — the reliable deploy signal
    expect(body.built_at).toBe('20260607T160244Z');
    expect(body.version).toBe('1.0.0'); // contract semver stays constant (NOT a deploy signal)
  });

  it('falls back to build=dev / built_at=null when not injected (local/dev)', async () => {
    const req = new Request('http://localhost/api/v1/health');
    const res = await app.fetch(req, stubEnv());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.build).toBe('dev');
    expect(body.built_at).toBeNull();
  });

  it('does not require Authorization header', async () => {
    const req = new Request('http://localhost/api/v1/health');
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(200);
  });

  it('responds to OPTIONS preflight with 204 + CORS headers', async () => {
    const req = new Request('http://localhost/api/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.xlooop.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    const res = await app.fetch(req, stubEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});
