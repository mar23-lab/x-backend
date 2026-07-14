// mcp-read-audit.test.ts · L2 (260710-D) · day-grain MCP tenant-read audit.
// DECLARED AXES: flag OFF ⇒ zero writes + byte-identical responses · flag ON ⇒ one upsert per read with
// the right (workspace, tool, actor) · a THROWING audit sql never breaks the read · store fire-and-forget
// semantics (lazy makeSql, no-call on disabled/missing-ids).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mcpCustomerReadsRoute } from '../routes/mcp-customer-reads';
import { recordMcpRead } from '../dal/mcp-access-store';

const AUTH = { user_id: 'agent_tok_1', workspace_id: 'org_hy', email: 'svc@x.example', role: 'member' };

type SqlCall = { text: string; values: unknown[] };
function capturingSql(calls: SqlCall[]) {
  // tagged-template stub — returns [] for reads; records every invocation.
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve([]);
  };
}

function appWith(sqlStub: unknown, auth: Record<string, unknown> | null = AUTH) {
  const dal = { listEvidenceItems: async () => [] };
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    if (auth) ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    if (sqlStub) ctx.set('sql', sqlStub as never);
    await next();
  });
  app.route('/api/v1/mcp', mcpCustomerReadsRoute);
  return app;
}
const get = (app: Hono, path: string, env: Record<string, unknown> = {}) => app.request(`/api/v1/mcp${path}`, {}, env);

describe('L2 · MCP read audit (MCP_READ_AUDIT_ENABLED)', () => {
  it('flag OFF: /sources answers and NO mcp_access_log write is issued', async () => {
    const calls: SqlCall[] = [];
    const res = await get(appWith(capturingSql(calls)), '/sources', {});
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.text.includes('mcp_access_log'))).toBe(false);
  });

  it('flag ON: /sources issues the day-grain upsert with (workspace, tool, actor)', async () => {
    const calls: SqlCall[] = [];
    const res = await get(appWith(capturingSql(calls)), '/sources', { MCP_READ_AUDIT_ENABLED: 'true' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0)); // the fire-and-forget microtask
    const audit = calls.find((c) => c.text.includes('mcp_access_log'));
    expect(audit).toBeDefined();
    expect(audit!.values).toEqual(expect.arrayContaining(['org_hy', 'list_sources', 'agent_tok_1']));
  });

  it('flag ON: all four tools audit under their own tool name', async () => {
    const calls: SqlCall[] = [];
    const app = appWith(capturingSql(calls));
    const env = { MCP_READ_AUDIT_ENABLED: 'true' };
    await get(app, '/sources', env);
    await get(app, '/evidence?packet_id=pkt_1', env);
    await get(app, '/receipts', env);
    await get(app, '/documents', env);
    await new Promise((r) => setTimeout(r, 0));
    const tools = calls.filter((c) => c.text.includes('mcp_access_log')).map((c) => c.values[1]);
    expect(tools.sort()).toEqual(['get_document', 'get_evidence', 'list_receipts', 'list_sources']);
  });

  it('flag ON + THROWING sql: the read still answers 200 (audit is never load-bearing)', async () => {
    const throwing = () => { throw new Error('db down'); };
    const res = await get(appWith(throwing), '/sources', { MCP_READ_AUDIT_ENABLED: 'true' });
    expect(res.status).toBe(200);
  });
});

describe('L2 · recordMcpRead (store hook semantics)', () => {
  it('disabled ⇒ makeSql is NEVER called', () => {
    let built = false;
    recordMcpRead({ enabled: false, makeSql: () => { built = true; return (() => {}) as never; }, workspaceId: 'w', tool: 't', actorId: 'a', waitUntil: () => {} });
    expect(built).toBe(false);
  });

  it('missing workspace or actor ⇒ waitUntil is NEVER called', () => {
    let waited = 0;
    const mk = () => ((() => Promise.resolve([])) as never);
    recordMcpRead({ enabled: true, makeSql: mk, workspaceId: '', tool: 't', actorId: 'a', waitUntil: () => { waited += 1; } });
    recordMcpRead({ enabled: true, makeSql: mk, workspaceId: 'w', tool: 't', actorId: '', waitUntil: () => { waited += 1; } });
    expect(waited).toBe(0);
  });

  it('enabled + complete ids ⇒ exactly one waitUntil with the upsert', async () => {
    const calls: SqlCall[] = [];
    let waited = 0;
    recordMcpRead({
      enabled: true, makeSql: () => capturingSql(calls) as never,
      workspaceId: 'org_hy', tool: 'list_sources', actorId: 'agent_tok_1',
      waitUntil: (p) => { waited += 1; void p; },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(waited).toBe(1);
    expect(calls[0].text).toContain('ON CONFLICT (workspace_id, tool, actor_id, access_date)');
  });
});
