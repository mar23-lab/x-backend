// prompt-tags-route.test.ts · 2026-06-10 · W2 + W4
// Routes for durable prompt tags (GET/PUT/DELETE + migrate /cockpit-chat/prompt-tags) and the W4
// AI-enhance (POST /cockpit-chat/enhance-prompt). Asserts operator-only tenancy, the 600-char cap,
// add+edit-as-one-upsert, and that enhance is SUGGEST-only + never loses text. DAL + AI mocked.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };
const TAG = { tag_id: 'summarize', label: 'Summarize', message: 'Summarize what is happening here.', sort: 0, updated_at: '2026-06-10T09:00:00.000Z' };

type Cap = { upserted?: Record<string, unknown>; deleted?: [string, string]; migrated?: unknown[] };

function appWith(auth: Record<string, unknown>, dal: Record<string, unknown>, env: Record<string, unknown> = ENV) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); await next();
  });
  app.route('/api/v1', workspacesRoute);
  return { app, env };
}

function dalOk(cap: Cap): Record<string, unknown> {
  return {
    listPromptTagsForUser: async (_u: string) => [TAG],
    upsertPromptTagForUser: async (input: Record<string, unknown>) => { cap.upserted = input; return { ...TAG, ...input }; },
    bulkUpsertPromptTagsForUser: async (_u: string, tags: unknown[]) => { cap.migrated = tags; return tags.length; },
    deletePromptTagForUser: async (u: string, t: string) => { cap.deleted = [u, t]; return true; },
  };
}

describe('GET /cockpit-chat/prompt-tags', () => {
  it('403 for a non-operator', async () => {
    const { app, env } = appWith({ user_id: 'x' }, dalOk({}));
    expect((await app.request('/api/v1/cockpit-chat/prompt-tags', {}, env as never)).status).toBe(403);
  });
  it('returns the operator tags', async () => {
    const { app, env } = appWith({ user_id: MBP_OWNER }, dalOk({}));
    const res = await app.request('/api/v1/cockpit-chat/prompt-tags', {}, env as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { tags: unknown[] }).tags).toHaveLength(1);
  });
  it('degrades to empty when the DAL lacks the method', async () => {
    const { app, env } = appWith({ user_id: MBP_OWNER }, {});
    const res = await app.request('/api/v1/cockpit-chat/prompt-tags', {}, env as never);
    expect((await res.json() as { tags: unknown[] }).tags).toEqual([]);
  });
});

describe('PUT /cockpit-chat/prompt-tags (add = edit)', () => {
  it('400 when message is missing', async () => {
    const { app, env } = appWith({ user_id: MBP_OWNER }, dalOk({}));
    const res = await app.request('/api/v1/cockpit-chat/prompt-tags', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag_id: 't', label: 'L' }) }, env as never);
    expect(res.status).toBe(400);
  });
  it('400 when message exceeds 600 chars', async () => {
    const { app, env } = appWith({ user_id: MBP_OWNER }, dalOk({}));
    const res = await app.request('/api/v1/cockpit-chat/prompt-tags', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag_id: 't', label: 'L', message: 'x'.repeat(601) }) }, env as never);
    expect(res.status).toBe(400);
  });
  it('upserts and returns the tag (one write serves add and edit)', async () => {
    const cap: Cap = {};
    const { app, env } = appWith({ user_id: MBP_OWNER }, dalOk(cap));
    const res = await app.request('/api/v1/cockpit-chat/prompt-tags', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag_id: 'digest', label: 'Draft a digest', message: 'Draft a short digest.' }) }, env as never);
    expect(res.status).toBe(200);
    expect(cap.upserted?.tag_id).toBe('digest');
    expect(cap.upserted?.user_id).toBe(MBP_OWNER);
  });
});

describe('POST /cockpit-chat/prompt-tags/migrate + DELETE', () => {
  it('migrates a local set', async () => {
    const cap: Cap = {};
    const { app, env } = appWith({ user_id: MBP_OWNER }, dalOk(cap));
    const res = await app.request('/api/v1/cockpit-chat/prompt-tags/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tags: [{ id: 'a', label: 'A', message: 'a' }, { id: 'b', label: 'B', message: 'b' }] }) }, env as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { migrated: number }).migrated).toBe(2);
  });
  it('deletes a tag scoped to the operator', async () => {
    const cap: Cap = {};
    const { app, env } = appWith({ user_id: MBP_OWNER }, dalOk(cap));
    const res = await app.request('/api/v1/cockpit-chat/prompt-tags/summarize', { method: 'DELETE' }, env as never);
    expect(res.status).toBe(200);
    expect(cap.deleted).toEqual([MBP_OWNER, 'summarize']);
  });
});

describe('POST /cockpit-chat/enhance-prompt (W4 suggest-only)', () => {
  // AI binding that "improves" the text.
  const aiEnv = { ...ENV, AI: { run: async () => ({ response: 'Summarize the key activity, status, and what needs my attention here.' }) } };
  it('403 for a non-operator', async () => {
    const { app } = appWith({ user_id: 'x' }, {}, aiEnv);
    expect((await app.request('/api/v1/cockpit-chat/enhance-prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) }, aiEnv as never)).status).toBe(403);
  });
  it('returns {original, proposed, refined:true} when the model improves it', async () => {
    const { app } = appWith({ user_id: MBP_OWNER }, {}, aiEnv);
    const res = await app.request('/api/v1/cockpit-chat/enhance-prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'summarize' }) }, aiEnv as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { original: string; proposed: string; refined: boolean };
    expect(body.original).toBe('summarize');
    expect(body.refined).toBe(true);
    expect(body.proposed).toMatch(/needs my attention/);
  });
  it('degrades to the ORIGINAL (refined:false) when there is no AI binding (no lost text)', async () => {
    const { app } = appWith({ user_id: MBP_OWNER }, {}, ENV);
    const res = await app.request('/api/v1/cockpit-chat/enhance-prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'summarize' }) }, ENV as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { original: string; proposed: string; refined: boolean };
    expect(body.refined).toBe(false);
    expect(body.proposed).toBe('summarize');
  });
});
