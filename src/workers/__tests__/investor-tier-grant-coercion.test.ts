// investor-tier-grant-coercion.test.ts
//
// Regression (HR-INPUT-COERCION-NO-THROW-1): POST /investor/tier-1-grant must NOT 500 when the
// `email` field is absent. The bug: `body?.email?.trim().toLowerCase()` short-circuits to
// `undefined` at `?.trim()`, then `.toLowerCase()` throws `TypeError` → errorEnvelope → 500.
// The fix guards on `typeof emailRaw === 'string'`; a missing email coerces to '' and the grant
// proceeds. Auth + DAL are injected via test middleware; no network (Clerk no-ops without a key).

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { investorAdminRoute } from '../routes/investor';

const ENV = { CLERK_SECRET_KEY: '', DATABASE_URL: 'postgres://test' };

function appForAdmin(userId: string | undefined, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    if (userId) ctx.set('user_id', userId);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', investorAdminRoute);
  return app;
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(
    `/api/v1${path}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ENV as never,
  );
}

describe('POST /investor/tier-1-grant — HR-INPUT-COERCION-NO-THROW-1', () => {
  it('does NOT 500 when email is missing (clerk_user_id provided); coerces to empty string', async () => {
    const grantInvestorTier1 = vi.fn(async () => ({ id: 'ent_1', tier: 'tier-1', email: '' }));
    const res = await post(appForAdmin('admin_x', { grantInvestorTier1 }), '/investor/tier-1-grant', {
      clerk_user_id: 'user_abc',
    });
    expect(res.status).toBe(201);
    expect(grantInvestorTier1).toHaveBeenCalledWith(
      expect.objectContaining({ clerk_user_id: 'user_abc', email: '' }),
    );
  });

  it('still 401 without an admin user', async () => {
    const res = await post(appForAdmin(undefined, {}), '/investor/tier-1-grant', { clerk_user_id: 'user_abc' });
    expect(res.status).toBe(401);
  });

  it('still 400 when neither clerk_user_id nor access_request_id is provided', async () => {
    const res = await post(appForAdmin('admin_x', {}), '/investor/tier-1-grant', { email: 'x@y.com' });
    expect(res.status).toBe(400);
  });
});
