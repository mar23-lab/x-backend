// rate-limit.test.ts · R56 Stage 1 · middleware behavior (in-memory fallback path)
//
// Exercises the factory without a Cloudflare binding, so it follows the in-isolate
// fallback bucket. __resetFallbackBuckets() isolates each case.

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { rateLimit, rateLimitWhenFlag, __resetFallbackBuckets } from '../middleware/rate-limit';

function appWith(limit: number) {
  const app = new Hono();
  app.use('/x', rateLimit({ ip: { limit, periodSeconds: 60, bindingName: 'RATE_LIMITER_TEST' } }));
  app.get('/x', (c) => c.text('ok'));
  return app;
}

const ENV = {} as never;
const hit = (app: ReturnType<typeof appWith>, ip: string) =>
  app.fetch(new Request('http://localhost/x', { headers: { 'cf-connecting-ip': ip } }), ENV);

describe('rateLimit middleware (in-memory fallback)', () => {
  beforeEach(() => __resetFallbackBuckets());

  it('allows up to the limit then returns 429 with headers', async () => {
    const app = appWith(3);
    expect((await hit(app, '1.2.3.4')).status).toBe(200);
    expect((await hit(app, '1.2.3.4')).status).toBe(200);
    expect((await hit(app, '1.2.3.4')).status).toBe(200);
    const denied = await hit(app, '1.2.3.4');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toBe('60');
    expect(denied.headers.get('X-RateLimit-Limit')).toBe('3');
    const body = (await denied.json()) as { code: string; bucket: string };
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.bucket).toBe('ip');
  });

  it('keeps a separate bucket per IP', async () => {
    const app = appWith(1);
    expect((await hit(app, '10.0.0.1')).status).toBe(200);
    expect((await hit(app, '10.0.0.2')).status).toBe(200); // different IP, own bucket
    expect((await hit(app, '10.0.0.1')).status).toBe(429); // first IP over limit
  });

  it('uses the authenticated-IP Cloudflare binding for bearer traffic', async () => {
    const app = new Hono();
    app.use('/x', rateLimit());
    app.get('/x', (c) => c.text('ok'));
    const calls = { anonymous: [] as string[], authenticated: [] as string[] };
    const env = {
      RATE_LIMITER_IP: {
        limit: async ({ key }: { key: string }) => { calls.anonymous.push(key); return { success: true }; },
      },
      RATE_LIMITER_AUTH_IP: {
        limit: async ({ key }: { key: string }) => { calls.authenticated.push(key); return { success: true }; },
      },
    };

    const anonymous = await app.fetch(new Request('http://localhost/x', {
      headers: { 'cf-connecting-ip': '203.0.113.10' },
    }), env as never);
    const authenticated = await app.fetch(new Request('http://localhost/x', {
      headers: {
        authorization: 'Bearer signed-session-token',
        'cf-connecting-ip': '203.0.113.10',
      },
    }), env as never);

    expect(anonymous.status).toBe(200);
    expect(authenticated.status).toBe(200);
    expect(calls.anonymous).toEqual(['ip:203.0.113.10']);
    expect(calls.authenticated).toEqual(['ip:203.0.113.10']);
  });
});

describe('rateLimitWhenFlag (SF-2 · flag-gated safety cap)', () => {
  beforeEach(() => __resetFallbackBuckets());
  const appFlag = () => {
    const app = new Hono();
    app.use('/x', rateLimitWhenFlag('SAFETY_FLOOR_RATELIMIT_ENABLED', { ip: { limit: 1, periodSeconds: 60, bindingName: 'RATE_LIMITER_TEST' } }));
    app.get('/x', (c) => c.text('ok'));
    return app;
  };
  const hitEnv = (app: ReturnType<typeof appFlag>, ip: string, env: Record<string, unknown>) =>
    app.fetch(new Request('http://localhost/x', { headers: { 'cf-connecting-ip': ip } }), env as never);

  it('flag OFF (unset) → NEVER limits, byte-identical passthrough', async () => {
    const app = appFlag();
    for (let i = 0; i < 5; i++) expect((await hitEnv(app, '9.9.9.9', {})).status).toBe(200);
  });

  it('flag OFF (explicit false) → NEVER limits', async () => {
    const app = appFlag();
    for (let i = 0; i < 5; i++) expect((await hitEnv(app, '9.9.9.9', { SAFETY_FLOOR_RATELIMIT_ENABLED: 'false' })).status).toBe(200);
  });

  it("flag ON ('true') → applies the cap (limit 1 → 2nd hit 429)", async () => {
    const app = appFlag();
    const ON = { SAFETY_FLOOR_RATELIMIT_ENABLED: 'true' };
    expect((await hitEnv(app, '8.8.8.8', ON)).status).toBe(200);
    expect((await hitEnv(app, '8.8.8.8', ON)).status).toBe(429);
  });
});
