// folder-promote-route.test.ts · ARCH-006 W6 · folder→packet linker
// POST /api/v1/folder-sources/promote: operator-initiated promotion of a folder change into a governance
// packet (a needs-review board item). Asserts operator-only tenancy, owned-workspace gate, that it writes
// ONE governance row via the reused materialize path + a needs_review event mirror, idempotent row_id, and
// that the promoted row classifies as `needsrev` (the board/chat round-trip). DAL mocked.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';
import { folderChangeToPacketRow } from '../sources/translators/folder';
import { classifyGovernanceRow, mapGovernanceRowsToEvents } from '../services/cockpit-chat';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

type Capture = { govRows?: unknown[]; event?: Record<string, unknown> };

function dalFor(cap: Capture, opts: { promoteThrows?: boolean } = {}): Record<string, unknown> {
  return {
    listWorkspacesForOperator: async () => [{ id: 'mbp-private' }],
    getFolderBindingMeta: async () => ({ project_id: 'mbp-private-governance', path: '/Users/x/vault' }),
    materializeGovernanceSnapshot: async (rows: unknown[]) => { if (opts.promoteThrows) throw new Error('unified missing'); cap.govRows = rows; return rows.length; },
    upsertEvent: async (_ws: string, event: Record<string, unknown>) => { cap.event = event; return { id: event.id, created: true }; },
  };
}

const post = (auth: Record<string, unknown>, body: Record<string, unknown>, dal: Record<string, unknown>) => {
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('request_id', 'test'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); await next(); });
  app.route('/api/v1', workspacesRoute);
  return app.request('/api/v1/folder-sources/promote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, ENV as never);
};

const CHANGE = { binding_id: 'psb-1', workspace_id: 'mbp-private', change: { kind: 'modified', path: 'notes/plan.md', checksum: 'abc12345' } };

describe('POST /folder-sources/promote', () => {
  it('403 for a non-operator', async () => {
    expect((await post({ user_id: 'someone-else' }, CHANGE, dalFor({}))).status).toBe(403);
  });
  it('403 when the workspace is not owned', async () => {
    const dal = dalFor({}); dal.listWorkspacesForOperator = async () => [{ id: 'other' }];
    expect((await post({ user_id: MBP_OWNER }, CHANGE, dal)).status).toBe(403);
  });
  it('400 when the change is malformed', async () => {
    expect((await post({ user_id: MBP_OWNER }, { binding_id: 'psb-1', workspace_id: 'mbp-private', change: { kind: 'nope', path: 'x' } }, dalFor({}))).status).toBe(400);
  });
  it('201 writes ONE governance packet (derived project_id) + a needs_review event mirror', async () => {
    const cap: Capture = {};
    const res = await post({ user_id: MBP_OWNER }, CHANGE, dalFor(cap));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { packet: { row_id: string; status: string; project_id: string }; packet_written: number; event_recorded: boolean };
    expect(body.packet_written).toBe(1);
    expect(body.packet.status).toBe('needs_review');
    expect(body.packet.project_id).toBe('mbp-private-governance'); // derived from getFolderBindingMeta
    expect((cap.govRows as Array<{ project_id: string }>)[0].project_id).toBe('mbp-private-governance');
    expect(body.event_recorded).toBe(true);
    expect((cap.event as { status: string }).status).toBe('needs_review');
    expect((cap.event as { approval_state: string }).approval_state).toBe('pending');
    expect(String((cap.event as { id: string }).id)).toMatch(/^evt_folder_pkt_/);
  });
  it('idempotent — promoting the same change yields the same deterministic row_id', async () => {
    const a: Capture = {}; const b: Capture = {};
    await post({ user_id: MBP_OWNER }, CHANGE, dalFor(a));
    await post({ user_id: MBP_OWNER }, CHANGE, dalFor(b));
    expect((a.govRows as Array<{ row_id: string }>)[0].row_id).toBe((b.govRows as Array<{ row_id: string }>)[0].row_id);
  });
  it('best-effort — a failing materialize never 5xx (still 201, packet_written 0)', async () => {
    const res = await post({ user_id: MBP_OWNER }, CHANGE, dalFor({}, { promoteThrows: true }));
    expect(res.status).toBe(201);
    expect((await res.json() as { packet_written: number }).packet_written).toBe(0);
  });
});

describe('folderChangeToPacketRow — classification round-trip (board/chat needs-you)', () => {
  it('the promoted row classifies as needsrev (waiting on the operator)', () => {
    const row = folderChangeToPacketRow(
      { binding_id: 'psb-1', workspace_id: 'mbp-private', project_id: 'mbp-private-governance', path: '/x/vault' },
      'modified', { path: 'notes/plan.md', checksum: 'abc12345' }, '2026-06-11T00:00:00.000Z',
    );
    expect(classifyGovernanceRow(row as never)).toBe('needsrev');
    const scope = { workspace_id: 'mbp-private', project_id: 'mbp-private-governance', domain_id: null };
    const mapped = mapGovernanceRowsToEvents([row as never], scope);
    expect(mapped.length).toBe(1);
    expect(mapped[0].status).toBe('needs_review');
    expect(mapped[0].approval_state).toBe('pending');
    expect(mapped[0].next_action).toBe('owner_sign_off');
  });
  it('the packet row_id is distinct from the reflection_only event id (no collision)', () => {
    const row = folderChangeToPacketRow({ binding_id: 'psb-1', workspace_id: 'w', project_id: 'p', path: '/v' }, 'added', { path: 'a.md', checksum: 'deadbeef' }, '2026-06-11T00:00:00.000Z');
    expect(String(row.row_id)).toMatch(/^folderpkt-/);
    expect(String(row.row_id)).not.toMatch(/^evt-folder-/);
  });
});
