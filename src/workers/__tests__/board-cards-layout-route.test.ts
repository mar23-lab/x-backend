// board-cards-layout-route.test.ts · R5 (260710-B) · auth/tenant boundary coverage for two previously
// UNTESTED read routes. DECLARED AXES — board-cards: role [client→403 · member ok] · validation
// [project_id required · status enum] · tenant binding [listBoardCards bound to JWT workspace]. layout:
// auth [no user_id→401] · user-scoping [getOperatorLayout/putOperatorLayout keyed on auth.user_id] ·
// validation [unknown key→422 · oversize→422] · the "never hides data" default (empty overlay when unsaved).

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { boardCardsRoute } from '../routes/board-cards';
import { layoutRoute } from '../routes/layout';

function appFor(route: unknown, auth: Record<string, unknown> | null, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't'); if (auth) ctx.set('auth', auth as never); ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', route as never);
  return app;
}
const ENV = { DATABASE_URL: 'p' } as never;

describe('GET /board-cards', () => {
  const dal = () => ({ listBoardCards: vi.fn(async () => [{ id: 'c1' }]) });

  it('client role → 403 (no board access)', async () => {
    const d = dal();
    const res = await appFor(boardCardsRoute, { workspace_id: 'ws1', role: 'client' }, d)
      .request('/api/v1/board-cards?project_id=p1', {}, ENV);
    expect(res.status).toBe(403);
    expect(d.listBoardCards).not.toHaveBeenCalled();
  });

  it('missing project_id → 400; invalid status → 400', async () => {
    const d = dal();
    expect((await appFor(boardCardsRoute, { workspace_id: 'ws1', role: 'viewer' }, d).request('/api/v1/board-cards', {}, ENV)).status).toBe(400);
    expect((await appFor(boardCardsRoute, { workspace_id: 'ws1', role: 'viewer' }, d).request('/api/v1/board-cards?project_id=p1&status=bogus', {}, ENV)).status).toBe(400);
    expect(d.listBoardCards).not.toHaveBeenCalled();
  });

  it('member → 200; the read is bound to the JWT workspace (never caller-supplied)', async () => {
    const d = dal();
    const res = await appFor(boardCardsRoute, { workspace_id: 'ws-MINE', role: 'operator' }, d)
      .request('/api/v1/board-cards?project_id=p1&workspace_id=ws-VICTIM', {}, ENV);
    expect(res.status).toBe(200);
    expect(d.listBoardCards.mock.calls[0][0]).toBe('ws-MINE'); // arg0 = workspace from auth, not the query
  });
});

describe('GET/PUT /layout · user-scoped overlay', () => {
  const dal = () => ({
    getOperatorLayout: vi.fn(async () => null),
    putOperatorLayout: vi.fn(async (_uid: string, layout: Record<string, unknown>) => ({ layout, updated_at: 'now' })),
  });

  it('no auth user → 401 on both verbs', async () => {
    const d = dal();
    expect((await appFor(layoutRoute, { user_id: '' }, d).request('/api/v1/layout', {}, ENV)).status).toBe(401);
    expect((await appFor(layoutRoute, { user_id: '' }, d).request('/api/v1/layout', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }, ENV)).status).toBe(401);
  });

  it('GET with no saved row → empty overlay (saved:false) — the "never hides data" default', async () => {
    const res = await appFor(layoutRoute, { user_id: 'u1' }, dal()).request('/api/v1/layout', {}, ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { saved: boolean; layout: { version: number } };
    expect(body.saved).toBe(false);
    expect(body.layout.version).toBe(1);
  });

  it('PUT rejects unknown keys (422) and oversize (422); a valid overlay saves under auth.user_id', async () => {
    const d = dal();
    const put = (body: string) => appFor(layoutRoute, { user_id: 'u9' }, d)
      .request('/api/v1/layout', { method: 'PUT', headers: { 'content-type': 'application/json' }, body }, ENV);
    expect((await put(JSON.stringify({ evil: 1 }))).status).toBe(422);
    expect((await put(JSON.stringify({ workspace_order: 'x'.repeat(70000) }))).status).toBe(422);
    const ok = await put(JSON.stringify({ workspace_order: ['ws1', 'ws2'] }));
    expect(ok.status).toBe(200);
    expect(d.putOperatorLayout.mock.calls[0][0]).toBe('u9'); // keyed on the authed user
  });
});
