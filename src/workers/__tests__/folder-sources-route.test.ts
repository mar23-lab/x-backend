// folder-sources-route.test.ts · 2026-06-10 · W3
// Routes for the reflection-only folder connector (GET /folder-sources, POST /folder-sources/register,
// POST /folder-sources/sync). Asserts operator-only tenancy, the owned-workspace gate on register+sync,
// that register mints a binding + empty baseline, and that sync emits events for the diff. DAL mocked.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

type Cap = { put?: Record<string, unknown>; upserts?: unknown[]; binding?: Record<string, unknown> };

function appWith(auth: Record<string, unknown>, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); await next();
  });
  app.route('/api/v1', workspacesRoute);
  return app;
}

function dalOk(cap: Cap, baseline: Array<{ path: string; checksum: string }> = []): Record<string, unknown> {
  cap.upserts = [];
  return {
    listWorkspacesForOperator: async () => [{ id: 'ws-1' }, { id: 'mbp-private' }],
    listFolderBindingsForOperator: async (_w: string[]) => [{ binding_id: 'psb_demo', workspace_id: 'ws-1', project_id: 'proj-1', path: '/notes', file_count: 3, synced_at: '2026-06-10T09:00:00.000Z' }],
    // Phase D: register creates the CANONICAL project_source_bindings row; no existing binding to reuse.
    listProjectSourceBindings: async (_ws: string, _pj: string) => [],
    createProjectSourceBinding: async (_ws: string, pj: string, input: Record<string, unknown>) => {
      cap.binding = { project_id: pj, ...input };
      return { id: 'psb_test1', binding_id: 'psb_test1', source_kind: input.source_kind, project_id: pj, status: 'connected' };
    },
    getFolderBindingMeta: async () => null,
    putFolderBaseline: async (input: Record<string, unknown>) => { cap.put = input; },
    getFolderBaseline: async () => baseline,
    upsertEvent: async (_ws: string, ev: unknown) => { cap.upserts!.push(ev); return { id: (ev as { id: string }).id, created: true }; },
  };
}

describe('GET /api/v1/folder-sources', () => {
  it('403 for non-operator', async () => {
    expect((await appWith({ user_id: 'x' }, dalOk({})).request('/api/v1/folder-sources', {}, ENV as never)).status).toBe(403);
  });
  it('lists the operator folders', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalOk({})).request('/api/v1/folder-sources', {}, ENV as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { folders: unknown[] }).folders).toHaveLength(1);
  });
});

describe('POST /api/v1/folder-sources/register', () => {
  it('400 without workspace_id + path', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalOk({})).request('/api/v1/folder-sources/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws-1' }) }, ENV as never);
    expect(res.status).toBe(400);
  });
  it('400 when project_id is missing (a folder binds to a project)', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalOk({})).request('/api/v1/folder-sources/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws-1', path: '/x' }) }, ENV as never);
    expect(res.status).toBe(400);
  });
  it('403 when the workspace is not owned', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalOk({})).request('/api/v1/folder-sources/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'someone-else', project_id: 'proj-1', path: '/x' }) }, ENV as never);
    expect(res.status).toBe(403);
  });
  it('registers a folder → 201 + CANONICAL binding (psb id) + empty baseline keyed by that id', async () => {
    const cap: Cap = {};
    const res = await appWith({ user_id: MBP_OWNER }, dalOk(cap)).request('/api/v1/folder-sources/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws-1', project_id: 'proj-1', path: '/Users/op/notes' }) }, ENV as never);
    expect(res.status).toBe(201);
    const body = await res.json() as { binding_id: string; project_id: string; suggested_context?: { kind: string; tags: string[]; confidence: string } };
    expect(body.binding_id).toBe('psb_test1');            // canonical project_source_bindings id (NOT a throwaway fld-uuid)
    expect(body.project_id).toBe('proj-1');
    expect(cap.binding?.source_kind).toBe('desktop_folder');                       // created the canonical binding
    expect((cap.binding?.source_ref as { path?: string } | undefined)?.path).toBe('/Users/op/notes');
    expect(cap.put?.binding_id).toBe('psb_test1');        // baseline keyed by the binding id (the FK target)
    expect(cap.put?.files).toEqual([]);
    expect(cap.put?.project_id).toBe('proj-1');
    // R1 parity (2026-06-10 audit fix): register now returns a propose-then-confirm context hint
    // (the github bind route already did; the folder path dropped it).
    expect(body.suggested_context).toBeTruthy();
    expect(body.suggested_context?.tags).toContain('local');   // desktop_folder source-kind tag
  });

  it('R1 parity: a health-named folder path → suggested_context kind=life (Health)', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalOk({})).request('/api/v1/folder-sources/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws-1', project_id: 'proj-1', path: '/Users/op/health/fitness-log' }) }, ENV as never);
    expect(res.status).toBe(201);
    const body = await res.json() as { suggested_context?: { kind: string; domain_hint: string } };
    expect(body.suggested_context?.kind).toBe('life');
    expect(body.suggested_context?.domain_hint).toBe('Health');
  });
});

describe('POST /api/v1/folder-sources/sync', () => {
  it('403 for non-operator', async () => {
    const res = await appWith({ user_id: 'x' }, dalOk({})).request('/api/v1/folder-sources/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ binding_id: 'fld-1', workspace_id: 'ws-1', files: [] }) }, ENV as never);
    expect(res.status).toBe(403);
  });
  it('emits events for the diff against the baseline', async () => {
    const cap: Cap = {};
    const dal = dalOk(cap, [{ path: 'a.ts', checksum: '1' }]); // baseline has a.ts@1
    const res = await appWith({ user_id: MBP_OWNER }, dal).request('/api/v1/folder-sources/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ binding_id: 'fld-1', workspace_id: 'ws-1', files: [{ path: 'a.ts', checksum: '2' }, { path: 'b.ts', checksum: '9' }] }),
    }, ENV as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { emitted: number; added: number; modified: number };
    expect(body.modified).toBe(1); // a.ts changed
    expect(body.added).toBe(1);    // b.ts new
    expect(body.emitted).toBe(2);
    expect(cap.upserts).toHaveLength(2);
  });
  it('403 when syncing into a non-owned workspace', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalOk({})).request('/api/v1/folder-sources/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ binding_id: 'fld-1', workspace_id: 'not-mine', files: [] }) }, ENV as never);
    expect(res.status).toBe(403);
  });
});
