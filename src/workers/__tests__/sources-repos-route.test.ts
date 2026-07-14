// sources-repos-route.test.ts · 2026-06-07
//
// Route tests for GET /api/v1/sources/:id/repos (the repo picker's data source).
// The security property: a caller can only list repos for a GitHub source THEY
// own. We assert the guard ladder (401 unauth -> 404 not-owned -> 400 wrong
// provider -> 200) plus the happy-path response shape.
//
// The OAuth adapter is mocked (no Clerk call) and global fetch is stubbed for
// the happy path (the REAL listUserRepos runs against the stub), so there are no
// network calls. Ownership is enforced by dal.getUserSource, which the route
// trusts — the mock returns null to simulate "not found OR owned by someone else".

import { describe, it, expect, vi } from 'vitest';

// Override makeClerkOAuthAdapter (keep the module's other real exports) so token
// retrieval returns a stub token instead of calling Clerk.
vi.mock('../dal/clerk-oauth-adapter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, makeClerkOAuthAdapter: () => ({ getAccessToken: async () => ({ token: 'gho_test' }) }) };
});

import { Hono } from 'hono';
import { sourcesRoute } from '../routes/sources';

const ENV = { CLERK_SECRET_KEY: 'sk_test_x', DATABASE_URL: 'postgres://x' };

type GetUserSource = (userId: string, id: string) => Promise<unknown>;

function appFor(auth: Record<string, unknown>, getUserSource: GetUserSource) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', { getUserSource } as never);
    await next();
  });
  app.route('/api/v1', sourcesRoute);
  return app;
}

const reposReq = (auth: Record<string, unknown>, getUserSource: GetUserSource, id = 's1') =>
  appFor(auth, getUserSource).request(`/api/v1/sources/${id}/repos`, {}, ENV as never);

function ghFetchOk(repos: unknown[]) {
  return vi.fn(async () => ({
    status: 200,
    ok: true,
    headers: { get: (h: string) => (h === 'X-RateLimit-Remaining' ? '4999' : null) },
    json: async () => repos,
    text: async () => JSON.stringify(repos),
  }));
}

describe('GET /sources/:id/repos · security guards', () => {
  it('401 when unauthenticated', async () => {
    const res = await reposReq({}, async () => null);
    expect(res.status).toBe(401);
  });

  it('404 when the source is not found / not owned by the caller', async () => {
    const res = await reposReq({ user_id: 'u1' }, async () => null);
    expect(res.status).toBe(404);
  });

  it('400 when the source is not a github provider', async () => {
    const res = await reposReq({ user_id: 'u1' }, async () => ({ id: 's1', provider: 'dropbox' }));
    expect(res.status).toBe(400);
  });

  it('200 + mapped repos for an owned github source', async () => {
    vi.stubGlobal('fetch', ghFetchOk([
      { id: 1, name: 'demo', full_name: 'mar23/demo', owner: { login: 'mar23' }, default_branch: 'main', pushed_at: '2026-06-01T00:00:00Z', private: false, description: null, html_url: 'https://github.com/mar23/demo' },
    ]));
    try {
      const res = await reposReq({ user_id: 'u1' }, async (userId, id) => ({ id, provider: 'github', user_id: userId }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { provider: string; repos: Array<{ full_name: string }> };
      expect(body.provider).toBe('github');
      expect(body.repos).toHaveLength(1);
      expect(body.repos[0].full_name).toBe('mar23/demo');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
