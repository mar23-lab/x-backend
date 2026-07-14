// feedback-route.test.ts · T6 (260710) · the Test-mode feedback channel's backend.
// DECLARED AXES: flag [off 409 (inert) · on] · actor [provisioned member (any role submits) · unprovisioned ·
// owner vs viewer on the READ] · tenant binding [JWT workspace only] · caps [body 2000 · day-cap 429] ·
// audit [feedback_submitted mirror row].

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { feedbackRoute } from '../routes/feedback';

function sqlCounting(todayCount: number) {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('count(*)')) return Promise.resolve([{ n: todayCount }]);
    if (text.includes('INSERT INTO feedback')) {
      return Promise.resolve([{
        id: 'fb_1', workspace_id: values[1], user_id: values[2], body: values[3],
        target_label: values[4], page: values[5], mode: values[6], status: 'open', created_at: '2026-07-10T00:00:00Z',
      }]);
    }
    if (text.includes('FROM feedback')) return Promise.resolve([{ id: 'fb_1', workspace_id: 'ws-MINE', user_id: 'u1', body: 'x', target_label: null, page: null, mode: 'test', status: 'open', created_at: 'now' }]);
    return Promise.resolve([]);
  }) as never;
}

function appFor(auth: Record<string, unknown>, dal: Record<string, unknown>, sql: unknown) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); ctx.set('sql', sql as never);
    await next();
  });
  app.route('/api/v1', feedbackRoute);
  return app;
}
const PROVISIONED = () => {
  const audits: unknown[] = [];
  return { audits, getSessionEntitlement: async () => ({ state: 'approved_workspace' }), appendAuditLog: vi.fn(async (e: unknown) => { audits.push(e); }) };
};
const MEMBER = { user_id: 'u1', workspace_id: 'ws-MINE', role: 'viewer', email: 'v@x.t' };
const OWNER = { user_id: 'u_o', workspace_id: 'ws-MINE', role: 'owner', email: 'o@x.t' };
const ON = { DATABASE_URL: 'p', FEEDBACK_PERSISTENCE_ENABLED: 'true', ENTITLEMENT_ENFORCEMENT: 'off' } as never;
const OFF = { DATABASE_URL: 'p' } as never;
const post = (app: Hono, body: Record<string, unknown>, env: never) =>
  app.request('/api/v1/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);

describe('POST /feedback', () => {
  it('flag OFF (default) → 409 before anything (inert-by-default deploy safety)', async () => {
    const dal = PROVISIONED();
    const res = await post(appFor(MEMBER, dal, sqlCounting(0)), { body: 'x' }, OFF);
    expect(res.status).toBe(409);
  });

  it('flag ON: any PROVISIONED member (even viewer) submits → 201, tenant from JWT, audited + observability', async () => {
    const dal = PROVISIONED();
    const res = await post(appFor(MEMBER, dal, sqlCounting(0)), { body: 'the save button overlaps the composer', target_label: 'composer-send', page: '/cockpit' }, ON);
    expect(res.status).toBe(201);
    const body = await res.json() as { feedback_id: string };
    expect(body.feedback_id).toBe('fb_1');
    const audit = dal.audits[0] as Record<string, unknown>;
    expect(audit.action).toBe('feedback_submitted');
    expect(audit.workspace_id).toBe('ws-MINE'); // JWT-bound, never body-supplied
  });

  it('unprovisioned workspace → 403; oversize body → 400; day-cap → 429', async () => {
    const un = { ...PROVISIONED(), getSessionEntitlement: async () => ({ state: 'pending' }) };
    expect((await post(appFor(MEMBER, un, sqlCounting(0)), { body: 'x' }, ON)).status).toBe(403);
    const dal = PROVISIONED();
    expect((await post(appFor(MEMBER, dal, sqlCounting(0)), { body: 'y'.repeat(2001) }, ON)).status).toBe(400);
    expect((await post(appFor(MEMBER, dal, sqlCounting(50)), { body: 'ok' }, ON)).status).toBe(429);
  });
});

describe('GET /feedback · operator triage read', () => {
  it('viewer → 403; owner → 200 workspace-scoped list', async () => {
    const dal = PROVISIONED();
    expect((await appFor(MEMBER, dal, sqlCounting(0)).request('/api/v1/feedback', {}, ON)).status).toBe(403);
    const res = await appFor(OWNER, dal, sqlCounting(0)).request('/api/v1/feedback', {}, ON);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[] };
    expect(body.entries.length).toBe(1);
  });
});
