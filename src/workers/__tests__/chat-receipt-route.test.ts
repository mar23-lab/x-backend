// chat-receipt-route.test.ts · W2 (260708) · G4-read + G8 — receipts + customer audit export.
// DECLARED COVERAGE AXES: actors [owner · viewer · client · no-workspace · foreign-workspace prober] ·
// data_states [receipt w/ links · foreign receipt · absent receipt · pre-050 event (lineage_recorded=false)] ·
// redaction [model name never exposed · non-member actor → xlooop:operator · reason omitted].

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { chatReceiptRoute } from '../routes/chat-receipt';
import { customerAuditLogRoute } from '../routes/customer-audit-log';

// injectable sql: routes read ctx.get('sql'); chat-store/customer-audit-store call it as a tagged template.
function sqlReturning(rowsByNeedle: Array<{ needle: string; rows: unknown[] }>) {
  return ((strings: TemplateStringsArray, ..._v: unknown[]) => {
    const text = strings.join('?');
    for (const m of rowsByNeedle) if (text.includes(m.needle)) return Promise.resolve(m.rows);
    return Promise.resolve([]);
  }) as never;
}

function appFor(route: unknown, auth: Record<string, unknown>, dal: Record<string, unknown>, sql: unknown, env: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); ctx.set('sql', sql as never);
    await next();
  });
  app.route('/', route as never);
  return { app, env: { DATABASE_URL: 'postgres://fake@h/d', ...env } as never };
}

const RECEIPT_ROW = {
  workspace_id: 'ws-MINE', thread_user_id: 'u1', role: 'assistant', body: 'grounded answer', mode: 'watch',
  generated_by: 'llm', grounded_on: { events_considered: 2 }, grounding_event_ids: ['e1', 'e2'], created_at: '2026-07-08T00:00:00Z',
};
const LIVE_EVENTS = {
  listEvents: async () => ({ events: [
    { id: 'e1', occurred_at: 'x', status: 'completed', summary: 's1', source_tool: 'github', instrument_kind: 'human', authorized_by_user_id: 'u1' },
    { id: 'e2', occurred_at: 'y', status: 'blocked', summary: 's2', source_tool: 'operator', instrument_kind: null, authorized_by_user_id: null }, // pre-050 row
    { id: 'e-other', occurred_at: 'z', status: 'completed', summary: 'unrelated', source_tool: 'github' },
  ] }),
};

describe('GET /chat/receipt/:uid', () => {
  it('own receipt → 200 with live role-filtered events, G7 lineage_recorded, and NO model name', async () => {
    const sql = sqlReturning([{ needle: 'receipt_uid', rows: [RECEIPT_ROW] }]);
    const { app, env } = appFor(chatReceiptRoute, { user_id: 'u1', workspace_id: 'ws-MINE', role: 'owner' }, LIVE_EVENTS, sql);
    const res = await app.request('/chat/receipt/rcpt_abc', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { receipt: Record<string, unknown> };
    expect(body.receipt.generated_by).toBe('llm');
    expect(JSON.stringify(body)).not.toMatch(/claude|gpt|llama|anthropic|openai/i); // conservative: no vendor/model
    const live = body.receipt.live_events as Array<Record<string, unknown>>;
    expect(live.map((e) => e.event_id).sort()).toEqual(['e1', 'e2']); // ∩ grounding ids only, never e-other
    expect(live.find((e) => e.event_id === 'e1')!.lineage_recorded).toBe(true);
    expect(live.find((e) => e.event_id === 'e2')!.lineage_recorded).toBe(false); // G7 honesty on pre-050 rows
  });

  it('FOREIGN-workspace receipt → the SAME 404 as an absent one (no existence oracle)', async () => {
    const sqlForeign = sqlReturning([{ needle: 'receipt_uid', rows: [{ ...RECEIPT_ROW, workspace_id: 'ws-VICTIM' }] }]);
    const sqlAbsent = sqlReturning([]);
    const mk = (sql: unknown) => appFor(chatReceiptRoute, { user_id: 'u1', workspace_id: 'ws-MINE', role: 'owner' }, LIVE_EVENTS, sql);
    const a = mk(sqlForeign); const b = mk(sqlAbsent);
    const rA = await a.app.request('/chat/receipt/rcpt_x', {}, a.env);
    const rB = await b.app.request('/chat/receipt/rcpt_x', {}, b.env);
    expect(rA.status).toBe(404);
    expect(rB.status).toBe(404);
    expect((await rA.json() as { code: string }).code).toBe((await rB.json() as { code: string }).code); // indistinguishable
  });

  it('csv export uses the frozen column header', async () => {
    const sql = sqlReturning([{ needle: 'receipt_uid', rows: [RECEIPT_ROW] }]);
    const { app, env } = appFor(chatReceiptRoute, { user_id: 'u1', workspace_id: 'ws-MINE', role: 'owner' }, LIVE_EVENTS, sql);
    const res = await app.request('/chat/receipt/rcpt_abc?format=csv', {}, env);
    const text = await res.text();
    expect(text.split('\r\n')[0]).toBe('event_id,occurred_at,status,summary,source_tool,instrument_kind,lineage_recorded');
  });
});

const PROVISIONED = { getSessionEntitlement: async () => ({ state: 'approved_workspace' }) };
const AUDIT_ROWS = [
  { needle: 'FROM audit_logs', rows: [
    { occurred_at: '2026-07-08', actor_user_id: 'u-member', action: 'sign_off', target_type: 'event', target_id: 'e1', causation_id: 'e0', reason: 'SECRET free text' },
    { occurred_at: '2026-07-08', actor_user_id: 'u-OPERATOR-internal', action: 'provisioning', target_type: 'workspace', target_id: 'ws-MINE', causation_id: null, reason: 'internal note' },
  ] },
  { needle: 'FROM workspace_members', rows: [{ user_id: 'u-member' }] },
];

describe('GET /customer-audit-log · conservative redaction', () => {
  it('member actor passes through; non-member → xlooop:operator; reason NEVER present', async () => {
    const sql = sqlReturning(AUDIT_ROWS);
    const { app, env } = appFor(customerAuditLogRoute, { user_id: 'u-member', workspace_id: 'ws-MINE', role: 'owner' }, PROVISIONED, sql, { ENTITLEMENT_ENFORCEMENT: 'off' });
    const res = await app.request('/customer-audit-log', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: Array<Record<string, unknown>> };
    expect(body.entries[0].actor).toBe('u-member');
    expect(body.entries[1].actor).toBe('xlooop:operator');
    expect(JSON.stringify(body)).not.toContain('SECRET free text'); // reason omitted entirely
    expect(JSON.stringify(body)).not.toContain('u-OPERATOR-internal'); // internal principal never leaks
  });

  it('viewer role → 403 (governance surface is owner/operator-class)', async () => {
    const sql = sqlReturning(AUDIT_ROWS);
    const { app, env } = appFor(customerAuditLogRoute, { user_id: 'v1', workspace_id: 'ws-MINE', role: 'viewer' }, PROVISIONED, sql, { ENTITLEMENT_ENFORCEMENT: 'off' });
    const res = await app.request('/customer-audit-log', {}, env);
    expect(res.status).toBe(403);
  });

  it('unprovisioned workspace → 403 before any audit read', async () => {
    const sql = sqlReturning(AUDIT_ROWS);
    const { app, env } = appFor(customerAuditLogRoute, { user_id: 'u1', workspace_id: 'ws-MINE', role: 'owner' }, { getSessionEntitlement: async () => ({ state: 'pending' }) }, sql, {});
    const res = await app.request('/customer-audit-log', {}, env);
    expect(res.status).toBe(403);
  });
});

// ── W4 · document read-audit store + the ?kind=document_access facet ─────────────────────────────
import { recordDocumentAccessRow, recordChatGroundingReads } from '../dal/document-access-store';

describe('W4 · document access audit', () => {
  it('recordDocumentAccessRow upserts with the day-grain dedupe ON CONFLICT clause', async () => {
    const texts: string[] = [];
    const sql = ((strings: TemplateStringsArray, ..._v: unknown[]) => { texts.push(strings.join('?')); return Promise.resolve([]); }) as never;
    await recordDocumentAccessRow(sql, 'ws1', 'd1', 'u1');
    expect(texts[0]).toContain('INSERT INTO document_access_log');
    expect(texts[0]).toContain('ON CONFLICT (workspace_id, document_id, user_id, access_date)');
    expect(texts[0]).toContain('read_count = document_access_log.read_count + 1');
  });

  it('recordDocumentAccessRow NEVER throws (pre-059 schema) — the read is never slowed/broken by its audit', async () => {
    const sql = (() => Promise.reject(new Error('relation document_access_log does not exist'))) as never;
    await expect(recordDocumentAccessRow(sql, 'ws1', 'd1', 'u1')).resolves.toBeUndefined();
  });

  // C4 · the extracted cockpit-chat grounding-read hook (the real consumption path, now route-testable).
  it('recordChatGroundingReads · flag-off → no waitUntil, Neon client never built', () => {
    let sqlBuilt = false, waited = false;
    recordChatGroundingReads({
      enabled: false, documents: [{ id: 'd1' }],
      makeSql: () => { sqlBuilt = true; return (() => Promise.resolve([])) as never; },
      workspaceId: 'ws1', userId: 'u1', waitUntil: () => { waited = true; },
    });
    expect(sqlBuilt).toBe(false);
    expect(waited).toBe(false);
  });

  it('recordChatGroundingReads · flag-on but no groundable doc ids → no waitUntil, no client', () => {
    let sqlBuilt = false, waited = false;
    recordChatGroundingReads({
      enabled: true, documents: [{ id: '' }, {}, { id: null }],
      makeSql: () => { sqlBuilt = true; return (() => Promise.resolve([])) as never; },
      workspaceId: 'ws1', userId: 'u1', waitUntil: () => { waited = true; },
    });
    expect(waited).toBe(false);
    expect(sqlBuilt).toBe(false);
  });

  it('recordChatGroundingReads · flag-on with docs → one upsert per real id, id-less skipped, attributed to the asker', async () => {
    const seenDocIds: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => { seenDocIds.push(String(vals[1])); return Promise.resolve([]); }) as never;
    let awaited: Promise<unknown> | null = null;
    recordChatGroundingReads({
      enabled: true, documents: [{ id: 'd1' }, { id: 'd2' }, { id: '' }, {}],
      makeSql: () => sql, workspaceId: 'ws1', userId: 'u1',
      waitUntil: (p) => { awaited = p; },
    });
    expect(awaited).not.toBeNull();
    await awaited;
    expect(seenDocIds.sort()).toEqual(['d1', 'd2']); // exactly the two real ids; empty/missing skipped
  });

  it('?kind=document_access facet returns the access rows (owner-gated like the main trail)', async () => {
    const sql = sqlReturning([{ needle: 'FROM document_access_log', rows: [
      { document_id: 'd1', user_id: 'u-member', access_date: '2026-07-08', access_source: 'chat_grounding', read_count: 3, last_read_at: '2026-07-08T10:00:00Z' },
    ] }]);
    const { app, env } = appFor(customerAuditLogRoute, { user_id: 'u-member', workspace_id: 'ws-MINE', role: 'owner' }, PROVISIONED, sql, { ENTITLEMENT_ENFORCEMENT: 'off' });
    const res = await app.request('/customer-audit-log?kind=document_access', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string; entries: Array<Record<string, unknown>> };
    expect(body.kind).toBe('document_access');
    expect(body.entries[0].read_count).toBe(3);
  });
});
