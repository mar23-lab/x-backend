// workspace-activity-route.test.ts · 2026-06-08
//
// Route tests for GET /api/v1/workspaces/:id/activity-summary (the retention value-surface
// data endpoint). Asserts the fail-closed tenancy: a member reads their own workspace, the
// operator reads any, a non-member is 403, a client is 403, and ?since passes through.
// The DAL is mocked (no DB).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

const SUMMARY = {
  workspace_id: 'ws1', events_total: 10, events_completed: 6, signoffs_total: 3, projects_total: 2,
  connected_sources: 1, first_activity_at: '2026-05-01T00:00:00Z', last_activity_at: '2026-06-06T00:00:00Z',
  days_of_history: 37, needs_you: 2, since: null, events_since: 0, signoffs_since: 0,
};

function appFor(auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', {
      getWorkspaceActivitySummary: async (id: string, since?: string | null) => ({ ...SUMMARY, workspace_id: id, since: since ?? null }),
    } as never);
    await next();
  });
  app.route('/api/v1', workspacesRoute);
  return app;
}
const get = (auth: Record<string, unknown>, path = '/api/v1/workspaces/ws1/activity-summary') =>
  appFor(auth).request(path, {}, ENV as never);

describe('GET /workspaces/:id/activity-summary · tenancy', () => {
  it('200 for a member of their own resolved workspace', async () => {
    const res = await get({ user_id: 'u1', workspace_id: 'ws1', role: 'owner' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { workspace_id: string; events_total: number } };
    expect(body.summary.workspace_id).toBe('ws1');
    expect(body.summary.events_total).toBe(10);
  });

  it('200 for the operator on ANY workspace (cross-scope)', async () => {
    const res = await get({ user_id: MBP_OWNER, workspace_id: 'mbp', role: 'operator' }, '/api/v1/workspaces/customer-ws/activity-summary');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { workspace_id: string } };
    expect(body.summary.workspace_id).toBe('customer-ws');
  });

  it('403 for a non-operator requesting a workspace they are not resolved into', async () => {
    const res = await get({ user_id: 'u2', workspace_id: 'their-ws', role: 'owner' }, '/api/v1/workspaces/someone-else/activity-summary');
    expect(res.status).toBe(403);
  });

  it('403 for a client role even on their own workspace', async () => {
    const res = await get({ user_id: 'u3', workspace_id: 'ws1', role: 'client' });
    expect(res.status).toBe(403);
  });

  it('passes ?since through to the summary delta', async () => {
    const res = await get({ user_id: 'u1', workspace_id: 'ws1', role: 'owner' }, '/api/v1/workspaces/ws1/activity-summary?since=2026-06-05T00:00:00Z');
    const body = (await res.json()) as { summary: { since: string } };
    expect(body.summary.since).toBe('2026-06-05T00:00:00Z');
  });
});
