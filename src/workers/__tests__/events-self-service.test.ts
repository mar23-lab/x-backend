// events-self-service.test.ts · PR3 (260628) · E1/E3 customer event soft-delete + restore + recently-deleted
//
// SECURITY-SENSITIVE. These tests pin the P.3 invariant and the three footguns flagged in the plan:
//   - the org-reassert (orgless JWT → 403, never act with workspace_id='')
//   - the cross-tenant guard (a foreign/guessed event id → DAL updated:0 → 404, never a cross-tenant write)
//   - the owner-role gate (viewer/client → 403)
//   - the feature flag (CUSTOMER_SELF_SERVICE_ENABLED off → 403, ships dormant)

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { eventsRoute } from '../routes/events';
import { restoreEventRow } from '../dal/event-store';

function appFor(auth: Record<string, unknown> | null, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    if (auth) ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', eventsRoute);
  return app;
}

// archiveEvent/restoreEvent → { updated }: 1 = touched a row in THIS workspace, 0 = nothing matched
// (foreign id / not archived). listArchivedEvents → the recently-deleted rows (with archived_at).
function dalStub(overrides: Record<string, unknown> = {}) {
  return {
    archiveEvent: async () => ({ updated: 1 }),
    restoreEvent: async () => ({
      updated: 1,
      target_event_id: 'evt_1',
      restore_receipt_id: 'evt_restore_evt_1_test',
      audit_event_id: 'evt_restore_evt_1_test',
    }),
    listArchivedEvents: async () => [
      { id: 'evt_1', summary: 's', body: 'b', source_tool: 'xlooop', project_id: null, archived_at: '2026-06-28T00:00:00Z' },
    ],
    ...overrides,
  };
}

const ON = { CUSTOMER_SELF_SERVICE_ENABLED: 'true' };
const OWNER = { user_id: 'user_codelooop', workspace_id: 'org_hy', role: 'owner', email: 'c@hy.example' };

describe('events self-service · E1 soft-delete + restore (PR3)', () => {
  it('owner soft-deletes their own event → archived (flag on)', async () => {
    const res = await appFor(OWNER, dalStub()).request('/api/v1/events/evt_1', { method: 'DELETE' }, ON as never);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archived?: boolean }).archived).toBe(true);
  });

  it('restore reverses it → restored', async () => {
    const res = await appFor(OWNER, dalStub()).request('/api/v1/events/evt_1/restore', { method: 'POST' }, ON as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restored?: boolean; target_event_id?: string; restore_receipt_id?: string; audit_event_id?: string };
    expect(body.restored).toBe(true);
    expect(body.target_event_id).toBe('evt_1');
    expect(body.restore_receipt_id).toBe('evt_restore_evt_1_test');
    expect(body.audit_event_id).toBe('evt_restore_evt_1_test');
  });

  it('restore with zero target rows fails closed without a receipt', async () => {
    const dal = dalStub({ restoreEvent: async () => ({ updated: 0, target_event_id: null, restore_receipt_id: null, audit_event_id: null }) });
    const res = await appFor(OWNER, dal).request('/api/v1/events/evt_missing/restore', { method: 'POST' }, ON as never);
    expect(res.status).toBe(404);
  });

  it('SECURITY · cross-tenant / unknown id → 404 (DAL updated:0, never a cross-tenant write)', async () => {
    const dal = dalStub({ archiveEvent: async () => ({ updated: 0 }) });
    const res = await appFor(OWNER, dal).request('/api/v1/events/evt_foreign', { method: 'DELETE' }, ON as never);
    expect(res.status).toBe(404);
  });

  it('SECURITY · orgless JWT (no workspace_id) → 403 (org-reassert)', async () => {
    const res = await appFor({ user_id: 'u', role: 'owner', email: 'x@y.z' }, dalStub())
      .request('/api/v1/events/evt_1', { method: 'DELETE' }, ON as never);
    expect(res.status).toBe(403);
  });

  it('SECURITY · non-owner (viewer/client) → 403 (role gate)', async () => {
    const res = await appFor({ ...OWNER, role: 'viewer' }, dalStub())
      .request('/api/v1/events/evt_1', { method: 'DELETE' }, ON as never);
    expect(res.status).toBe(403);
  });

  it('flag off → 403 (ships dormant)', async () => {
    const res = await appFor(OWNER, dalStub()).request('/api/v1/events/evt_1', { method: 'DELETE' }, {} as never);
    expect(res.status).toBe(403);
  });
});

describe('events self-service · restore receipt SQL', () => {
  it('requires target_updated before a restore receipt can be selected', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    }) as never;

    const out = await restoreEventRow(sql, 'org_hy', 'evt_missing', 'user_codelooop', 'req_1');
    expect(out).toEqual({ updated: 0, target_event_id: null, restore_receipt_id: null, audit_event_id: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/WITH target_updated AS/);
    expect(calls[0]!.text).toMatch(/INSERT INTO operation_events/);
    expect(calls[0]!.text).toMatch(/FROM target_updated\s+JOIN event_written ON TRUE/);
  });
});

describe('events self-service · E3 recently-deleted (PR3)', () => {
  it('owner reads recently-deleted within the 30-day window (flag on)', async () => {
    const res = await appFor(OWNER, dalStub()).request('/api/v1/events/archived', {}, ON as never);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { window_days?: number; items?: unknown[] };
    expect(out.window_days).toBe(30);
    expect(out.items).toHaveLength(1);
  });

  it('flag off → 403', async () => {
    const res = await appFor(OWNER, dalStub()).request('/api/v1/events/archived', {}, {} as never);
    expect(res.status).toBe(403);
  });
});
