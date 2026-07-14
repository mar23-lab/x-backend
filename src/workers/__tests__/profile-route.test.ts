// profile-route.test.ts · Stage 2 · GET /api/v1/me
// The authed user's identity (Clerk JWT) + DB-backed account attributes (`users` row).
// User-scoped, read-only. "real, or honestly-absent": falls back to JWT identity when
// there is no DB row, prefers the JWT's verified email, never fabricates, never 5xx.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { profileRoute } from '../routes/profile';

const ENV = { DATABASE_URL: 'x' };

function appFor(auth: Record<string, unknown> | null, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    if (auth) ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', profileRoute);
  return app;
}

const DB_USER = {
  id: 'user_abc', email: 'real@db.example', status: 'active', is_admin: false,
  approved_at: '2026-01-01T00:00:00.000Z', created_at: '2024-01-15T10:30:00.000Z',
  updated_at: '2026-06-26T12:00:00.000Z', metadata: {}, approved_by: null,
  rejection_reason: null, suspended_at: null,
};

describe('GET /api/v1/me', () => {
  it('returns JWT identity + DB account attributes (source db+jwt; JWT email preferred)', async () => {
    const cap: { id?: string } = {};
    const app = appFor({ user_id: 'user_abc', email: 'jwt@token.example' }, {
      getUser: async (id: string) => { cap.id = id; return DB_USER; },
    });
    const res = await app.request('/api/v1/me', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown>; source: string };
    expect(cap.id).toBe('user_abc');
    expect(body.source).toBe('db+jwt');
    expect(body.user).toMatchObject({
      id: 'user_abc',
      email: 'jwt@token.example',           // JWT email preferred over the DB row
      status: 'active',
      is_admin: false,
      created_at: '2024-01-15T10:30:00.000Z',
    });
  });

  it('falls back to JWT identity when no DB row exists (source jwt; account fields null)', async () => {
    const app = appFor({ user_id: 'user_new', email: 'new@token.example' }, {
      getUser: async () => null,
    });
    const res = await app.request('/api/v1/me', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown>; source: string };
    expect(body.source).toBe('jwt');
    expect(body.user).toMatchObject({
      id: 'user_new', email: 'new@token.example', status: null, created_at: null, is_admin: false,
    });
  });

  it('never 5xx when the DAL throws — degrades to JWT identity', async () => {
    const app = appFor({ user_id: 'user_x', email: 'x@token.example' }, {
      getUser: async () => { throw new Error('users table unavailable'); },
    });
    const res = await app.request('/api/v1/me', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; user: Record<string, unknown> };
    expect(body.source).toBe('jwt');
    expect(body.user.id).toBe('user_x');
  });

  it('is 401 when auth is missing', async () => {
    const app = appFor(null, { getUser: async () => null });
    const res = await app.request('/api/v1/me', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(401);
  });
});
