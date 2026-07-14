// packet-intent-quality.test.ts — P3 (260714, Operability wave · G2 defense-in-depth).
//
// PACKET_INTENT_QUALITY_ENABLED rejects bare-verb / one-word packet titles with a structured 400 so
// EVERY client is protected, not only the wired adapter (live incident 260714: the chat words
// "execute" and "proceed" became junk governed packets titled "Packet · execute"). Flag unset =>
// byte-identical passthrough (rollout is operator-named).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { operationalSpineRoute } from '../routes/operational-spine';

const OPERATOR = { user_id: 'user_op', role: 'operator', workspace_id: 'tenant_a' };

function appFor() {
  const dal = {
    createTaskPacket: async (ws: string, actor: string, input: Record<string, unknown>) => ({
      id: 'pkt_new', workspace_id: ws, actor_user_id: actor, ...input,
    }),
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', OPERATOR as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', operationalSpineRoute);
  return app;
}

const post = (title: string, env: Record<string, unknown>) =>
  appFor().request('/api/v1/packets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, summary: title }),
  }, env as never);

describe('PACKET_INTENT_QUALITY_ENABLED (P3 260714)', () => {
  it('flag UNSET: bare verbs still pass (byte-identical rollout safety)', async () => {
    const res = await post('execute', { DATABASE_URL: 'x' });
    expect(res.status).toBe(201);
  });

  it('flag ON: the live-incident bare verbs are rejected with intent_too_thin', async () => {
    for (const title of ['execute', 'proceed', 'Packet · proceed', 'yes', 'ship it']) {
      const res = await post(title, { DATABASE_URL: 'x', PACKET_INTENT_QUALITY_ENABLED: 'true' });
      expect(res.status, title).toBe(400);
      const body = (await res.json()) as { message?: string; error?: { message?: string } };
      const msg = body.message || (body.error && body.error.message) || JSON.stringify(body);
      expect(msg, title).toMatch(/intent_too_thin/);
    }
  });

  it('flag ON: one-word / sub-minimum titles are rejected', async () => {
    for (const title of ['fix', 'deploy', 'Onboarding']) {
      const res = await post(title, { DATABASE_URL: 'x', PACKET_INTENT_QUALITY_ENABLED: 'true' });
      expect(res.status, title).toBe(400);
    }
  });

  it('flag ON: a describable intent passes and persists verbatim', async () => {
    const res = await post('Draft the eligibility appendix for the TAS page', { DATABASE_URL: 'x', PACKET_INTENT_QUALITY_ENABLED: 'true' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { packet: { id: string; title: string } };
    expect(body.packet.id).toBe('pkt_new');
    expect(body.packet.title).toBe('Draft the eligibility appendix for the TAS page');
  });
});
