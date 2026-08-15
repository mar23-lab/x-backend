// cors-methods.test.ts · 260708 · locks the CORS preflight to allow the mutating REST methods.
// A live smoke test caught that ALLOWED_METHODS was 'GET, POST, OPTIONS' — so cross-origin PUT/PATCH/DELETE
// (session-mode PATCH, members role-change PATCH, model-runtimes PUT/DELETE) were preflight-blocked by the
// browser ("Method PUT is not allowed by Access-Control-Allow-Methods"). This freezes the full method set.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { corsMiddleware } from '../middleware/cors';

function app() {
  const a = new Hono();
  a.use('*', corsMiddleware());
  a.all('/x', (c) => c.text('ok'));
  return a;
}
const ENV = { ALLOWED_ORIGIN_PATTERN: 'https://*.xlooop.com' } as never;

describe('CORS preflight — allowed methods', () => {
  it('the OPTIONS preflight allows GET/POST/PUT/PATCH/DELETE (no cross-origin write is preflight-blocked)', async () => {
    const res = await app().request('/x', { method: 'OPTIONS', headers: { origin: 'https://app.xlooop.com' } }, ENV);
    expect(res.status).toBe(204);
    const methods = res.headers.get('Access-Control-Allow-Methods') || '';
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(methods, `Access-Control-Allow-Methods must include ${m}`).toContain(m);
    }
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.xlooop.com');
  });

  it('preflight-allowlists the Authorization + workspace-assert headers', async () => {
    const res = await app().request('/x', { method: 'OPTIONS', headers: { origin: 'https://app.xlooop.com' } }, ENV);
    const hdrs = res.headers.get('Access-Control-Allow-Headers') || '';
    expect(hdrs).toContain('Authorization');
    expect(hdrs).toContain('X-Xlooop-Workspace-Assert');
    expect(hdrs).toContain('Idempotency-Key'); // governed writes (live-data.js) send this; missing here => all writes fail CORS preflight ("Failed to fetch")
  });

  it('exposes response correlation to allowed browser origins', async () => {
    const responseApp = new Hono();
    responseApp.use('*', corsMiddleware());
    responseApp.all('/x', (ctx) => {
      ctx.header('X-Request-Id', 'request-visible-to-browser');
      return ctx.json({ request_id: 'request-visible-to-browser' });
    });

    const res = await responseApp.request('/x', {
      headers: { origin: 'https://app.xlooop.com' },
    }, ENV);

    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-Id');
    expect(res.headers.get('X-Request-Id')).toBe('request-visible-to-browser');
  });

  it('a non-xlooop origin is not granted Access-Control-Allow-Origin', async () => {
    const res = await app().request('/x', { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }, ENV);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('pilot-shadow Pages previews are allowed only for the test frontend project', async () => {
    const pilotEnv = { ALLOWED_ORIGIN_PATTERN: 'https://*.xlooop-test.pages.dev' } as never;
    for (const origin of [
      'https://0325a910.xlooop-test.pages.dev',
      'https://main.xlooop-test.pages.dev',
    ]) {
      const res = await app().request('/x', { method: 'OPTIONS', headers: { origin } }, pilotEnv);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }

    const otherPagesProject = await app().request('/x', { method: 'OPTIONS', headers: { origin: 'https://preview.other.pages.dev' } }, pilotEnv);
    expect(otherPagesProject.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // test.xlooop.com is the existing Access-protected, Clerk-compatible nonproduction origin.
  it('pilot-shadow allows both the xlooop.com test host and the test Pages previews', async () => {
    const pilotEnv = {
      ALLOWED_ORIGIN_PATTERN: 'https://test.xlooop.com,https://*.xlooop-test.pages.dev',
    } as never;
    for (const origin of [
      'https://test.xlooop.com',
      'https://main.xlooop-test.pages.dev',
    ]) {
      const res = await app().request('/x', { method: 'OPTIONS', headers: { origin } }, pilotEnv);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }

    // The multi-entry pattern must not become an allow-all: production, sibling hosts, and other
    // Pages projects stay refused.
    for (const origin of [
      'https://app.xlooop.com',
      'https://evil.test.xlooop.com',
      'https://test.xlooop.com.attacker.dev',
      'https://preview.other.pages.dev',
    ]) {
      const res = await app().request('/x', { method: 'OPTIONS', headers: { origin } }, pilotEnv);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('a stray comma or empty entry cannot degrade the pattern into an allow-all', async () => {
    const sloppyEnv = { ALLOWED_ORIGIN_PATTERN: 'https://test.xlooop.com,,  ,' } as never;
    const allowed = await app().request('/x', { method: 'OPTIONS', headers: { origin: 'https://test.xlooop.com' } }, sloppyEnv);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://test.xlooop.com');
    const refused = await app().request('/x', { method: 'OPTIONS', headers: { origin: 'https://anything.example.com' } }, sloppyEnv);
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
