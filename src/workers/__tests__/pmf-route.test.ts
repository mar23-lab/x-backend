// pmf-route.test.ts · 2026-06-08
// Route tests for POST /api/v1/pmf (authed) + GET /api/v1/pmf-summary (operator-only). DAL mocked.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { pmfRoute } from '../routes/pmf';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

function appFor(auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', {
      recordPmfResponse: async (input: { user_id: string; workspace_id?: string | null; sentiment: string }) => ({
        id: 'pmf_1', user_id: input.user_id, workspace_id: input.workspace_id ?? null, sentiment: input.sentiment,
        benefit: null, improvement: null, persona: null, created_at: 'now', updated_at: 'now',
      }),
      getPmfSummary: async () => ({ total: 10, very_disappointed: 5, somewhat_disappointed: 3, not_disappointed: 2, very_disappointed_pct: 50 }),
    } as never);
    await next();
  });
  app.route('/api/v1', pmfRoute);
  return app;
}
const post = (auth: Record<string, unknown>, body: unknown) =>
  appFor(auth).request('/api/v1/pmf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, ENV as never);
const getSummary = (auth: Record<string, unknown>) =>
  appFor(auth).request('/api/v1/pmf-summary', {}, ENV as never);

describe('POST /pmf', () => {
  it('401 when unauthenticated', async () => {
    expect((await post({}, { sentiment: 'very_disappointed' })).status).toBe(401);
  });
  it('400 on an invalid sentiment', async () => {
    expect((await post({ user_id: 'u1', workspace_id: 'ws1' }, { sentiment: 'meh' })).status).toBe(400);
  });
  it('201 records a valid response', async () => {
    const res = await post({ user_id: 'u1', workspace_id: 'ws1' }, { sentiment: 'very_disappointed', benefit: 'the audit trail' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { recorded: { sentiment: string } };
    expect(body.recorded.sentiment).toBe('very_disappointed');
  });
});

describe('GET /pmf-summary', () => {
  it('403 for a non-operator', async () => {
    expect((await getSummary({ user_id: 'u2', workspace_id: 'ws1', role: 'owner' })).status).toBe(403);
  });
  it('200 + the very-disappointed % for the operator', async () => {
    const res = await getSummary({ user_id: MBP_OWNER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { very_disappointed_pct: number } };
    expect(body.summary.very_disappointed_pct).toBe(50);
  });
});
