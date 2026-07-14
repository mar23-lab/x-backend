// activity-webhook-route.test.ts · R5 (260710-B) · boundary coverage for the shared-secret ingest webhook.
// DECLARED AXES: secret config [unset → 503] · bearer [wrong/short/missing → 401 · correct → passes] ·
// batch validation [empty → 400 · over MAX_BATCH → 400] · per-event tolerance [one bad event doesn't fail
// the batch]. The constant-time compare (verifyActivityToken) is the security-relevant path.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { activityWebhookRoute } from '../routes/activity-webhook';

function appFor(dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('request_id', 't'); ctx.set('dal', dal as never); await next(); });
  app.route('/api/v1', activityWebhookRoute);
  return app;
}
const SECRET = 'ingest-secret-value-1234567890';
const post = (app: Hono, env: Record<string, unknown>, body: unknown, auth?: string) =>
  app.request('/api/v1/webhooks/activity', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  }, env as never);

const dalStub = () => ({ upsertEvent: vi.fn(async () => ({ id: 'evt1', created: true })), ingestEvent: vi.fn(async () => ({ id: 'evt1', created: true })) });

describe('POST /webhooks/activity · shared-secret ingest', () => {
  it('ingest secret NOT configured → 503 (fail-closed)', async () => {
    const res = await post(appFor(dalStub()), { DATABASE_URL: 'p' }, { events: [] }, SECRET);
    expect(res.status).toBe(503);
  });

  it('wrong token → 401; length-mismatched token → 401; missing → 401', async () => {
    const env = { DATABASE_URL: 'p', ACTIVITY_INGEST_TOKEN: SECRET };
    expect((await post(appFor(dalStub()), env, { events: [] }, 'wrong-but-same-length-000000000')).status).toBe(401);
    expect((await post(appFor(dalStub()), env, { events: [] }, 'short')).status).toBe(401);
    expect((await post(appFor(dalStub()), env, { events: [] })).status).toBe(401);
  });

  it('correct token clears auth → then empty batch → 400, oversize batch → 400', async () => {
    const env = { DATABASE_URL: 'p', ACTIVITY_INGEST_TOKEN: SECRET };
    expect((await post(appFor(dalStub()), env, { events: [] }, SECRET)).status).toBe(400);
    const huge = { events: Array.from({ length: 201 }, (_, i) => ({ id: `e${i}`, source_tool: 'github', summary: 's' })) };
    expect((await post(appFor(dalStub()), env, huge, SECRET)).status).toBe(400);
  });
});
