// admin-health-connectors.test.ts · W5-C/G10 (2026-06-15) · GET /admin/health/connectors
//
// Pre-flight health route: diffs the Clerk instance's enabled OAuth providers (fetched from the
// FAPI /v1/environment, domain derived from the publishable key) against CONNECTOR_REGISTRY.
// Covers OK / WARN / FAIL signals + the defensive UNKNOWN paths (no FAPI, fetch error) so a
// connector-config problem surfaces here, not as a runtime 502 at connect time.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { adminRoute } from '../routes/admin';

// pk_test_<base64('clerk.test.dev$')> — the route base64-decodes this to the FAPI domain.
const PK = 'pk_test_' + btoa('clerk.test.dev$');

function appFor() {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't');
    ctx.set('auth', { user_id: 'op', workspace_id: '' } as never);
    ctx.set('dal', {} as never);
    await next();
  });
  app.route('/api/v1', adminRoute);
  return app;
}

function fapiResponse(social: Record<string, { enabled: boolean }>) {
  return new Response(JSON.stringify({ user_settings: { social } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('GET /admin/health/connectors', () => {
  it('WARN when an extra provider is enabled in Clerk but absent from the registry (free-tier all on)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fapiResponse({
      oauth_github: { enabled: true }, oauth_google: { enabled: true },
      oauth_dropbox: { enabled: true }, oauth_apple: { enabled: true },
    })));
    const res = await appFor().request('/api/v1/admin/health/connectors', {}, { CLERK_PUBLISHABLE_KEY: PK } as never);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, any>;
    expect(j.free_tier_not_enabled).toEqual([]);
    expect(j.clerk_enabled).toEqual(expect.arrayContaining(['github', 'google', 'dropbox']));
    expect(j.missing_in_registry).toContain('apple');
    expect(j.signal).toBe('WARN');
  });

  it('FAIL when a free-tier connector OAuth app is OFF in Clerk (would 502 on connect)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fapiResponse({
      oauth_github: { enabled: true }, oauth_dropbox: { enabled: true }, // google OFF
    })));
    const res = await appFor().request('/api/v1/admin/health/connectors', {}, { CLERK_PUBLISHABLE_KEY: PK } as never);
    const j = (await res.json()) as Record<string, any>;
    expect(j.signal).toBe('FAIL');
    expect(j.free_tier_not_enabled).toContain('google');
  });

  it('UNKNOWN (never throws) when the FAPI fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const res = await appFor().request('/api/v1/admin/health/connectors', {}, { CLERK_PUBLISHABLE_KEY: PK } as never);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, any>;
    expect(j.signal).toBe('UNKNOWN');
  });

  it('UNKNOWN when the publishable key is absent (cannot derive FAPI domain)', async () => {
    const res = await appFor().request('/api/v1/admin/health/connectors', {}, {} as never);
    const j = (await res.json()) as Record<string, any>;
    expect(j.signal).toBe('UNKNOWN');
    expect(j.registry_declared).toEqual(expect.arrayContaining(['github', 'google', 'dropbox']));
  });
});
