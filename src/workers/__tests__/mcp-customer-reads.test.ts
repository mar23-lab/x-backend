// mcp-customer-reads.test.ts · T4/P7 (260710) · the tenant-scoped customer-data READ tools.
// DECLARED AXES: tenant binding [JWT/token workspace only · no-workspace 403] · redaction [D-8: non-member
// actor → xlooop:operator, reason NEVER present] · content hygiene [documents = metadata only, NO
// extracted_text] · degrade [store errors → empty lists, not 500s].

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mcpCustomerReadsRoute } from '../routes/mcp-customer-reads';
import { SAFE_TOOLS } from '../routes/mcp-gateway';

function sqlReturning(rowsByNeedle: Array<{ needle: string; rows: unknown[] }>) {
  return ((strings: TemplateStringsArray, ..._v: unknown[]) => {
    const text = strings.join('?');
    for (const m of rowsByNeedle) if (text.includes(m.needle)) return Promise.resolve(m.rows);
    return Promise.resolve([]);
  }) as never;
}

function appFor(auth: Record<string, unknown>, dal: Record<string, unknown>, sql: unknown) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); ctx.set('sql', sql as never);
    await next();
  });
  app.route('/mcp', mcpCustomerReadsRoute);
  return app;
}
const ENV = { DATABASE_URL: 'postgres://fake@h/d' } as never;
const AUTH = { user_id: 'u1', workspace_id: 'ws-MINE', role: 'operator' };

describe('the 4 read tools are REGISTERED in SAFE_TOOLS (all GET — reads only, per the operator decision)', () => {
  it('list_sources / get_evidence / list_receipts / get_document present, all GET', () => {
    for (const name of ['xlooop.list_sources', 'xlooop.get_evidence', 'xlooop.list_receipts', 'xlooop.get_document']) {
      const tool = SAFE_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeTruthy();
      expect(tool!.method).toBe('GET');
    }
  });
});

describe('tenant binding + shape', () => {
  it('no workspace binding → 403 on every tool', async () => {
    const app = appFor({ user_id: 'u1', workspace_id: '' }, {}, sqlReturning([]));
    for (const p of ['/mcp/sources', '/mcp/receipts', '/mcp/documents', '/mcp/evidence?packet_id=p1']) {
      expect((await app.request(p, {}, ENV)).status, p).toBe(403);
    }
  });

  it('list_sources reads the WORKSPACE-scoped rows (WHERE workspace_id, not user_id)', async () => {
    const sql = sqlReturning([{ needle: 'WHERE workspace_id', rows: [
      { id: 's1', workspace_id: 'ws-MINE', user_id: 'u9', provider: 'gmail', provider_user_id: 'g', provider_username: 'a@b',
        scopes: ['gmail.readonly'], contract: 'metadata_only', status: 'connected', connected_at: '2026-07-01T00:00:00Z',
        last_sync_at: null, last_sync_error: null, created_at: 'x', updated_at: 'x' },
    ] }]);
    const res = await appFor(AUTH, {}, sql).request('/mcp/sources', {}, ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { sources: Array<Record<string, unknown>> };
    expect(body.sources[0].provider).toBe('gmail');
    expect(body.sources[0].scopes).toEqual(['gmail.readonly']);
  });

  it('get_evidence requires packet_id and stays workspace-bound via the DAL call', async () => {
    let calledWs = '';
    const dal = { listEvidenceItems: async (w: string) => { calledWs = w; return [{ id: 'ev1' }]; } };
    const app = appFor(AUTH, dal, sqlReturning([]));
    expect((await app.request('/mcp/evidence', {}, ENV)).status).toBe(400); // no packet_id
    const res = await app.request('/mcp/evidence?packet_id=pkt-1', {}, ENV);
    expect(res.status).toBe(200);
    expect(calledWs).toBe('ws-MINE');
  });
});

describe('D-8 redaction + content hygiene', () => {
  it('receipts: non-member actor → xlooop:operator; free-text reason NEVER present', async () => {
    const sql = sqlReturning([
      { needle: 'FROM audit_logs', rows: [
        { occurred_at: '2026-07-09T00:00:00Z', actor_user_id: 'u-member', action: 'sign_off', target_type: 'event', target_id: 'e1', causation_id: null, reason: 'SECRET internal note' },
        { occurred_at: '2026-07-08T00:00:00Z', actor_user_id: 'u-OPERATOR-internal', action: 'provisioning', target_type: 'workspace', target_id: 'ws-MINE', causation_id: null, reason: 'ops' },
      ] },
      { needle: 'FROM workspace_members', rows: [{ user_id: 'u-member' }] },
    ]);
    const res = await appFor(AUTH, {}, sql).request('/mcp/receipts', {}, ENV);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('"actor":"u-member"');
    expect(text).toContain('xlooop:operator');
    expect(text).not.toContain('SECRET internal note');   // reason omitted (D-8)
    expect(text).not.toContain('u-OPERATOR-internal');    // internal principal never leaks
  });

  it('documents: METADATA ONLY — extracted_text never crosses the MCP surface', async () => {
    // listDocumentsRow runs under withWorkspaceRlsContext → the sql stub needs .transaction (driver shape:
    // cb(tx) returns the statement array; results[0] = the GUC set_config, sliced off by the wrapper).
    const DOC = { id: 'd1', workspace_id: 'ws-MINE', project_id: null, filename: 'contract.pdf', content_type: 'application/pdf',
      size_bytes: 10, extracted_text: 'TOP-SECRET-CONTENT that must never leave the grounding plane',
      uploaded_by: 'u1', uploaded_at: '2026-07-01T00:00:00Z', status: 'ready', admissibility: 'approved',
      content_hash: 'abc', version: 1, supersedes_id: null };
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join('?'), values }) as never;
    (tag as unknown as { transaction: unknown }).transaction = async (cb: (tx: unknown) => unknown[]) =>
      cb(tag).map((q) => (String((q as { text?: string })?.text || '').includes('FROM documents') ? [DOC] : []));
    const res = await appFor(AUTH, {}, tag).request('/mcp/documents', {}, ENV);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('contract.pdf');
    expect(text).not.toContain('TOP-SECRET-CONTENT');
  });
});
