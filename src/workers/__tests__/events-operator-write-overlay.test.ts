// events-operator-write-overlay.test.ts
//
// Route tests for the R55-3b operator chat-composer write overlay on
// POST /api/v1/events. The verified platform owner runs ORGLESS sessions
// (role='viewer', workspace_id=''), so the normal org+role gate would 403 their
// own cockpit composer. The overlay lets them write ONLY to a workspace THEY own
// (verified by dal.operatorOwnsWorkspace), and nothing widens the tenant boundary
// for anyone else.
//
// Mocks the DAL (ctx.set) so the suite never imports WorkersDalAdapter (avoids the
// pre-existing snakecase-keys CJS/ESM collection issue in adapter-importing suites).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { eventsRoute } from '../routes/events';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

// Capture what upsertEvent was called with so we can assert the resolved workspace.
function mockDal(calls: Array<{ ws: string; id: string }>) {
  return {
    // operator owns mbp-private + me; nobody else owns anything
    operatorOwnsWorkspace: async (ids: string[], ws: string) =>
      ids.includes(MBP_OWNER) && (ws === 'mbp-private' || ws === 'me'),
    upsertEvent: async (ws: string, event: { id: string }) => {
      calls.push({ ws, id: event.id });
      return { id: event.id, created: true };
    },
  };
}

function appFor(auth: Record<string, unknown>, calls: Array<{ ws: string; id: string }>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', mockDal(calls) as never);
    await next();
  });
  app.route('/api/v1', eventsRoute);
  return app;
}

const VALID = {
  id: 'evt-test-1',
  source_tool: 'operator',
  status: 'queued',
  summary: 'operator composer message',
  occurred_at: '2026-05-31T00:00:00.000Z',
};

function post(auth: Record<string, unknown>, body: Record<string, unknown>) {
  const calls: Array<{ ws: string; id: string }> = [];
  const app = appFor(auth, calls);
  return app
    .request('/api/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, ENV as never)
    .then((res) => ({ res, calls }));
}

describe('POST /events · operator write overlay (R55-3b)', () => {
  it('orgless operator → owned target_workspace_id → 201, writes to THAT workspace', async () => {
    const { res, calls } = await post(
      { user_id: MBP_OWNER, role: 'viewer', workspace_id: '' },
      { ...VALID, target_workspace_id: 'mbp-private' },
    );
    expect(res.status).toBe(201);
    expect(calls).toEqual([{ ws: 'mbp-private', id: 'evt-test-1' }]);
  });

  it('orgless operator → target_workspace_id they do NOT own → 403, no write', async () => {
    const { res, calls } = await post(
      { user_id: MBP_OWNER, role: 'viewer', workspace_id: '' },
      { ...VALID, target_workspace_id: 'aps-pty-ltd' },
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('orgless operator → NO target_workspace_id → 403 (cannot guess scope)', async () => {
    const { res, calls } = await post(
      { user_id: MBP_OWNER, role: 'viewer', workspace_id: '' },
      { ...VALID },
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('orgless NON-operator → 403 even with a target_workspace_id', async () => {
    const { res, calls } = await post(
      { user_id: 'user_random', role: 'viewer', workspace_id: '' },
      { ...VALID, target_workspace_id: 'mbp-private' },
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('in-org agent (normal path) → 201, writes to JWT workspace, ignores target_workspace_id', async () => {
    const { res, calls } = await post(
      { user_id: 'user_member', role: 'operator', workspace_id: 'aps-pty-ltd' },
      { ...VALID, target_workspace_id: 'mbp-private' },
    );
    expect(res.status).toBe(201);
    expect(calls).toEqual([{ ws: 'aps-pty-ltd', id: 'evt-test-1' }]);
  });

  it('in-org viewer → 403 (role gate unchanged)', async () => {
    const { res, calls } = await post(
      { user_id: 'user_member', role: 'viewer', workspace_id: 'aps-pty-ltd' },
      { ...VALID },
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('orgless operator → owned target but missing required fields → 400, no write', async () => {
    const { res, calls } = await post(
      { user_id: MBP_OWNER, role: 'viewer', workspace_id: '' },
      { target_workspace_id: 'mbp-private', summary: 'no id/source/status' },
    );
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
