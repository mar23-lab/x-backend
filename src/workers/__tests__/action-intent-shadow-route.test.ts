import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { actionIntentShadowRoute } from '../routes/action-intent-shadow';

function app(flag?: string) {
  const instance = new Hono();
  instance.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', { user_id: 'u1', workspace_id: 'tenant_a', role: 'operator' } as never);
    await next();
  });
  instance.route('/api/v1', actionIntentShadowRoute);
  return { instance, env: { ACTION_INTENT_SHADOW_ENABLED: flag } };
}

describe('action-intent shadow route', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is default-off', async () => {
    const { instance, env } = app();
    const response = await instance.request('/api/v1/action-intent/shadow', { method: 'POST', body: JSON.stringify({ text: 'plan the release' }), headers: { 'content-type': 'application/json' } }, env);
    expect(response.status).toBe(404);
  });

  it('returns advisory action intent without role or skill claims', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { instance, env } = app('true');
    const rawText = 'continue with the remaining tests secret-marker-731';
    const response = await instance.request('/api/v1/action-intent/shadow', { method: 'POST', body: JSON.stringify({ text: rawText }), headers: { 'content-type': 'application/json' } }, env);
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ classification: { action_intent: 'continue_work' }, authority: 'advisory_shadow_only' });
    expect(JSON.stringify(body)).not.toMatch(/role|skill/);
    expect(JSON.stringify(log.mock.calls)).not.toContain(rawText);
  });
});
