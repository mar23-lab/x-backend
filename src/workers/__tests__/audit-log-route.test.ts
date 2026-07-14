// audit-log-route.test.ts · 2026-06-10 · Wave 4
// GET /api/v1/audit-log — the governance audit trail (sign-offs + the events they act on) across the
// operator's workspaces. Operator-only; degrades to an empty trail; reads listGovernanceAuditLogForOperator.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

function appFor(auth: Record<string, unknown>, dal: Record<string, unknown>) {
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

const ENTRY = {
  actor_user_id: MBP_OWNER, action: 'sign_off_approved', target_type: 'event',
  target_id: 'ev-1', workspace_id: 'mbp-private', reason: 'looks good',
  causation_id: 'ev-1', occurred_at: '2026-06-10T09:00:00.000Z',
};

describe('GET /api/v1/audit-log', () => {
  it('returns the governance audit trail for the operator', async () => {
    const cap: { ids?: string[]; limit?: number } = {};
    const app = appFor({ user_id: MBP_OWNER }, {
      listGovernanceAuditLogForOperator: async (ids: string[], limit: number) => { cap.ids = ids; cap.limit = limit; return [ENTRY]; },
    });
    const res = await app.request('/api/v1/audit-log?limit=50', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries.length).toBe(1);
    expect(body.entries[0]).toMatchObject({ action: 'sign_off_approved', target_type: 'event', causation_id: 'ev-1' });
    expect(cap.ids).toContain(MBP_OWNER);
    expect(cap.limit).toBe(50);
  });

  it('is 403 for a non-operator', async () => {
    const app = appFor({ user_id: 'someone-else' }, { listGovernanceAuditLogForOperator: async () => [] });
    const res = await app.request('/api/v1/audit-log', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(403);
  });

  it('degrades to an empty trail when the DAL throws (never 5xx)', async () => {
    const app = appFor({ user_id: MBP_OWNER }, { listGovernanceAuditLogForOperator: async () => { throw new Error('no causation_id column'); } });
    const res = await app.request('/api/v1/audit-log', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });
});
