// session-mode.test.ts · Wave B · PATCH /api/v1/session/mode — audited operating-mode write.
// Injects auth + a fake dal and asserts the route contract: mode validation, auth/workspace gates, the
// (user, workspace, mode, actor) DAL call, and the 4-axis identity echo.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { sessionModeRoute } from '../routes/session-mode';

function appFor(
  dal: Record<string, unknown>,
  auth: { user_id: string; workspace_id: string; role: string } = { user_id: 'u1', workspace_id: 'org_a', role: 'operator' },
) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', sessionModeRoute);
  return app;
}

function patch(app: ReturnType<typeof appFor>, mode: unknown) {
  return app.request('/api/v1/session/mode', {
    method: 'PATCH',
    body: JSON.stringify({ mode }),
    headers: { 'content-type': 'application/json' },
  });
}

describe('PATCH /session/mode', () => {
  it('200 — sets the mode; DAL called with (user, workspace, mode, actor); echoes 4-axis identity', async () => {
    const setOperatingMode = vi.fn(async () => 'operator');
    const res = await patch(appFor({ setOperatingMode }), 'operator');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity).toEqual({
      role: 'operator', operating_mode: 'operator', session_mode: 'authenticated', visibility: 'system-internal',
    });
    expect(setOperatingMode).toHaveBeenCalledWith('u1', 'org_a', 'operator', 'u1');
  });

  it('400 — a free-text/invalid mode is rejected before touching the DAL', async () => {
    const setOperatingMode = vi.fn();
    const res = await patch(appFor({ setOperatingMode }), 'godmode');
    expect(res.status).toBe(400);
    expect(setOperatingMode).not.toHaveBeenCalled();
  });

  it('visibility axis derives from role — a client gets client-visible, a viewer agency-visible', async () => {
    const setOperatingMode = vi.fn(async () => 'watch');
    const rC = await patch(appFor({ setOperatingMode }, { user_id: 'c', workspace_id: 'org_a', role: 'client' }), 'watch');
    expect((await rC.json()).identity.visibility).toBe('client-visible');
    const rV = await patch(appFor({ setOperatingMode }, { user_id: 'v', workspace_id: 'org_a', role: 'viewer' }), 'watch');
    expect((await rV.json()).identity.visibility).toBe('agency-visible');
  });

  it('403 — no workspace in session', async () => {
    const res = await patch(appFor({ setOperatingMode: vi.fn() }, { user_id: 'u1', workspace_id: '', role: 'operator' }), 'operator');
    expect(res.status).toBe(403);
  });
});
