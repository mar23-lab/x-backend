// workspace-upgrade-route.test.ts · U4a (260708) · the audited "request upgrade" backend (no billing).
// DECLARED AXES: actor [provisioned member · unprovisioned · no-workspace] · effect [durable audit row
// written with the right action/target · NO entitlement mutation · ack even if notify/audit throws].

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { workspaceUpgradeRoute } from '../routes/workspace-upgrade';

const PROVISIONED = { state: 'approved_workspace' };

function appFor(auth: Record<string, unknown>, opts: { entitlement?: unknown; appendAuditLog?: (e: unknown) => Promise<void> } = {}) {
  const audits: unknown[] = [];
  const dal = {
    getSessionEntitlement: async () => opts.entitlement ?? PROVISIONED,
    appendAuditLog: opts.appendAuditLog ?? (async (e: unknown) => { audits.push(e); }),
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('request_id', 't'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); await next(); });
  app.route('/', workspaceUpgradeRoute as never);
  const env = { DATABASE_URL: 'postgres://fake@h/d', ADMIN_NOTIFICATION_EMAIL: '' } as never;
  return { app, env, audits };
}
const post = (app: Hono, body: unknown, env: never) =>
  app.request('/workspace/upgrade-request', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, env);

describe('POST /workspace/upgrade-request', () => {
  it('provisioned member → 202 + a durable audit row (action account_upgrade_requested, target workspace)', async () => {
    const { app, env, audits } = appFor({ user_id: 'u1', workspace_id: 'ws-MINE', email: 'a@b.co', role: 'viewer' });
    const res = await post(app, { tier: 'premium', note: 'need more seats' }, env);
    expect(res.status).toBe(202);
    const body = await res.json() as { ok: boolean; request_id: string; status: string };
    expect(body.ok).toBe(true);
    expect(body.request_id).toMatch(/^upreq_/);
    expect(body.status).toBe('received');
    expect(audits.length).toBe(1);
    const a = audits[0] as Record<string, unknown>;
    expect(a.action).toBe('account_upgrade_requested');
    expect(a.target_type).toBe('workspace');
    expect(a.target_id).toBe('ws-MINE');
    expect(a.workspace_id).toBe('ws-MINE');
    expect((a.metadata as Record<string, unknown>).requested_tier).toBe('premium');
  });

  it('unprovisioned workspace → 403, NO audit row', async () => {
    const { app, env, audits } = appFor({ user_id: 'u1', workspace_id: 'ws-MINE', role: 'owner' }, { entitlement: { state: 'pending' } });
    const res = await post(app, {}, env);
    expect(res.status).toBe(403);
    expect(audits.length).toBe(0);
  });

  it('no signed-in workspace → 403', async () => {
    const { app, env } = appFor({ user_id: 'u1', workspace_id: '', role: 'owner' });
    const res = await post(app, {}, env);
    expect(res.status).toBe(403);
  });

  it('a durable-audit throw still returns 202 (best-effort; the customer ack is never blocked)', async () => {
    const { app, env } = appFor({ user_id: 'u1', workspace_id: 'ws-MINE', email: 'a@b.co', role: 'owner' },
      { appendAuditLog: async () => { throw new Error('db down'); } });
    const res = await post(app, { note: 'x' }, env);
    expect(res.status).toBe(202);
  });
});
