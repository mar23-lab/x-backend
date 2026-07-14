// usage-route.test.ts · 2026-06-10 · W1
// Route tests for the privacy-safe usage telemetry sink (POST/GET /api/v1/usage). Asserts operator-only
// tenancy, that a record is best-effort (202 even if the DAL write throws — telemetry never blocks the
// action), that the operator identity-set + kind pass through to the aggregate, and the response shape.
// DAL mocked.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

type Cap = { recorded?: Record<string, unknown>; aggArgs?: unknown[] };

function appWith(auth: Record<string, unknown>, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', workspacesRoute);
  return app;
}

function dalOk(cap: Cap): Record<string, unknown> {
  return {
    recordUsageEvent: async (input: Record<string, unknown>) => { cap.recorded = input; },
    aggregateUsageForOperator: async (ids: string[], kind: string, limit: number) => {
      cap.aggArgs = [ids, kind, limit];
      return [{ ref_id: 'summarize', clicks: 12, last_used_at: '2026-06-10T09:00:00.000Z' }];
    },
  };
}

describe('POST /api/v1/usage', () => {
  it('403 for a non-operator', async () => {
    const res = await appWith({ user_id: 'someone' }, dalOk({})).request('/api/v1/usage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'prompt_tag', ref_id: 'x' }),
    }, ENV as never);
    expect(res.status).toBe(403);
  });

  it('400 when kind is missing', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalOk({})).request('/api/v1/usage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref_id: 'x' }),
    }, ENV as never);
    expect(res.status).toBe(400);
  });

  it('records a usage event and returns 202 with the operator user_id stamped', async () => {
    const cap: Cap = {};
    const res = await appWith({ user_id: MBP_OWNER }, dalOk(cap)).request('/api/v1/usage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'prompt_tag', ref_id: 'summarize', scope_key: 'mbp-ops' }),
    }, ENV as never);
    expect(res.status).toBe(202);
    expect(cap.recorded?.kind).toBe('prompt_tag');
    expect(cap.recorded?.ref_id).toBe('summarize');
    expect(cap.recorded?.user_id).toBe(MBP_OWNER);
  });

  it('still returns 202 when the DAL write throws (telemetry never blocks the action)', async () => {
    const dal = { recordUsageEvent: async () => { throw new Error('db down'); } };
    const res = await appWith({ user_id: MBP_OWNER }, dal).request('/api/v1/usage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'prompt_tag', ref_id: 'x' }),
    }, ENV as never);
    expect(res.status).toBe(202);
  });
});

describe('GET /api/v1/usage', () => {
  it('400 when kind is missing', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalOk({})).request('/api/v1/usage', {}, ENV as never);
    expect(res.status).toBe(400);
  });

  it('returns the operator aggregates and passes the identity-set + kind to the DAL', async () => {
    const cap: Cap = {};
    const res = await appWith({ user_id: MBP_OWNER }, dalOk(cap)).request('/api/v1/usage?kind=prompt_tag', {}, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage: Array<Record<string, unknown>> };
    expect(body.usage[0]!.ref_id).toBe('summarize');
    expect(body.usage[0]!.clicks).toBe(12);
    const [ids, kind] = cap.aggArgs as [string[], string, number];
    expect(ids).toContain(MBP_OWNER);
    expect(kind).toBe('prompt_tag');
  });

  it('degrades to empty when the DAL lacks the method', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, {}).request('/api/v1/usage?kind=prompt_tag', {}, ENV as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { usage: unknown[] }).usage).toEqual([]);
  });
});
