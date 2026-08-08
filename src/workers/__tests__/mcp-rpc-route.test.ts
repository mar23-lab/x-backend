// mcp-rpc-route.test.ts
//
// Behavioral tests for the hosted Streamable-HTTP / JSON-RPC MCP endpoint. The app dispatch is
// mocked so these assert MCP protocol correctness + that tools/call re-dispatches to the existing
// REST handlers with the caller's auth forwarded — without touching Neon.
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createMcpRpcRoute, MCP_READ_TOOLS, MCP_SERVER_INFO } from '../routes/mcp-rpc';

type Call = { url: string; method: string; auth: string | null };

function appFor(calls: Call[]) {
  const dispatch = async (req: Request) => {
    calls.push({ url: req.url, method: req.method, auth: req.headers.get('Authorization') });
    const path = new URL(req.url).pathname;
    if (path === '/api/v1/mcp/session-start') {
      return new Response(JSON.stringify({
        schema_id: 'xcp.session_start/v1',
        gateway: { name: 'xcp-gateway', profile: 'customer' },
        gateway_profile: 'customer',
        detected_role: 'not_applicable',
        entry_skill: 'not_applicable',
        identity: { tenant_id: 'tenant_a' },
        scoped_tools: [{ name: 'xlooop.get_task_packet' }],
        requires_additional_gateway: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/v1/mcp/whoami') {
      return new Response(JSON.stringify({ schema_id: 'xlooop.mcp_whoami.v1', workspace_id: 'tenant_a' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not found', code: 'NOT_FOUND' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  const app = new Hono();
  app.route('/mcp', createMcpRpcRoute(dispatch));
  return app;
}

function rpc(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/mcp/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('mcp-rpc route', () => {
  it('initialize returns negotiated protocol + serverInfo + tools capability', async () => {
    const res = await rpc(appFor([]), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.result.protocolVersion).toBe('2025-06-18');
    expect(j.result.serverInfo).toEqual(MCP_SERVER_INFO);
    expect(j.result.serverInfo).toMatchObject({ name: 'xcp-gateway', profile: 'customer' });
    expect(JSON.stringify(j.result)).not.toContain('xlooop-customer-gateway');
    expect(j.result.capabilities.tools).toBeTruthy();
    expect(j.result.instructions).toContain('xcp_session_start once');
  });

  it('tools/call xcp_session_start completes customer intake in one authenticated gateway hop', async () => {
    const calls: Call[] = [];
    const res = await rpc(
      appFor(calls),
      { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'xcp_session_start', arguments: {} } },
      { Authorization: 'Bearer xlk_ro_test' },
    );
    const j: any = await res.json();
    expect(j.result.isError).toBe(false);
    expect(calls).toEqual([expect.objectContaining({
      method: 'GET', auth: 'Bearer xlk_ro_test',
    })]);
    expect(calls[0].url).toContain('/api/v1/mcp/session-start');
    const payload = JSON.parse(j.result.content[0].text);
    expect(payload).toMatchObject({
      schema_id: 'xcp.session_start/v1',
      gateway: { name: 'xcp-gateway', profile: 'customer' },
      gateway_profile: 'customer',
      detected_role: 'not_applicable',
      entry_skill: 'not_applicable',
      requires_additional_gateway: false,
    });
  });

  it('initialize falls back to a supported version for unknown client version', async () => {
    const res = await rpc(appFor([]), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    const j: any = await res.json();
    expect(j.result.protocolVersion).toBe('2025-06-18');
  });

  it('tools/list returns exactly the read-only allowlist with object schemas', async () => {
    const res = await rpc(appFor([]), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const j: any = await res.json();
    expect(j.result.tools.map((t: any) => t.name)).toEqual(MCP_READ_TOOLS.map((t) => t.name));
    for (const t of j.result.tools) expect(t.inputSchema.type).toBe('object');
  });

  it('tools/call whoami dispatches to the REST handler with forwarded auth', async () => {
    const calls: Call[] = [];
    const res = await rpc(
      appFor(calls),
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'xlooop.whoami', arguments: {} } },
      { Authorization: 'Bearer xlk_ro_test' },
    );
    const j: any = await res.json();
    expect(res.status).toBe(200);
    expect(j.result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/v1/mcp/whoami');
    expect(calls[0].auth).toBe('Bearer xlk_ro_test');
    expect(JSON.parse(j.result.content[0].text).schema_id).toBe('xlooop.mcp_whoami.v1');
  });

  it('tools/call get_task_packet without id is a JSON-RPC invalid-params error', async () => {
    const res = await rpc(appFor([]), { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'xlooop.get_task_packet', arguments: {} } });
    const j: any = await res.json();
    expect(j.error.code).toBe(-32602);
  });

  it('tools/call for a non-allowlisted tool is rejected (no forbidden-surface reach)', async () => {
    const calls: Call[] = [];
    const res = await rpc(appFor(calls), { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'xlooop.delete_everything', arguments: {} } });
    const j: any = await res.json();
    expect(j.error.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  it('notifications/initialized acknowledges with 202 and no body', async () => {
    const res = await rpc(appFor([]), { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
  });

  it('unknown method returns method-not-found (-32601)', async () => {
    const res = await rpc(appFor([]), { jsonrpc: '2.0', id: 6, method: 'resources/list' });
    const j: any = await res.json();
    expect(j.error.code).toBe(-32601);
  });

  it('GET descriptor advertises the streamable-http transport + tool names', async () => {
    const res = await appFor([]).request('/mcp/rpc', { method: 'GET' });
    const j: any = await res.json();
    expect(j.transport).toBe('streamable-http');
    expect(j).toMatchObject({
      schema_id: 'xcp.mcp_rpc_descriptor.v1', gateway_name: 'xcp-gateway', profile: 'customer',
    });
    expect(j.tools).toContain('xcp_session_start');
    expect(j.tools).toContain('xlooop.whoami');
    expect(JSON.stringify(j)).not.toContain('xlooop-customer-gateway');
  });

  // ── Stage-0 parity pin (260806) ────────────────────────────────────────────────────────────────
  // tools/list once under-reported the advertised surface by 8: four finished customer-data reads
  // sat in SAFE_TOOLS and were never registered here (two hand-maintained lists — the enumerated-
  // list class). This pins the two lists together in BOTH directions so they can never drift again:
  // every GET in SAFE_TOOLS must be a registered MCP tool, and every registered MCP tool that maps
  // to a SAFE_TOOLS path must carry the same published name. Writes are excluded EXPLICITLY (they
  // are typed shut in McpToolDef until the operational write connector is signed off) — a write
  // appearing in tools/list should fail this test until that design step is taken deliberately.
  it('PARITY: every SAFE_TOOLS read is a registered MCP tool and no MCP tool is unadvertised', async () => {
    const { SAFE_TOOLS } = await import('../routes/mcp-gateway');
    const safeReads = (SAFE_TOOLS as readonly { name: string; method: string }[]).filter((t) => t.method === 'GET');
    const mcpNames = new Set(MCP_READ_TOOLS.map((t) => t.name));
    const safeReadNames = new Set(safeReads.map((t) => t.name));

    const missingFromMcp = safeReads.map((t) => t.name).filter((n) => !mcpNames.has(n));
    expect(missingFromMcp, 'SAFE_TOOLS reads absent from tools/list').toEqual([]);

    // MCP tools not in SAFE_TOOLS: only the template-policy pair predates the advertisement and is
    // allowed by name; anything else must be advertised.
    const unadvertised = MCP_READ_TOOLS.map((t) => t.name).filter((n) => !safeReadNames.has(n));
    expect(unadvertised, 'MCP tools missing from the SAFE_TOOLS advertisement').toEqual([]);

    // Writes stay off the MCP surface until deliberately opened.
    const writes = (SAFE_TOOLS as readonly { name: string; method: string }[]).filter((t) => t.method !== 'GET');
    for (const w of writes) expect(mcpNames.has(w.name), `write ${w.name} must not be an MCP tool yet`).toBe(false);
  });

  it('the new cockpit-read tools build tenant-plane GET paths', () => {
    const byName = new Map(MCP_READ_TOOLS.map((t) => [t.name, t]));
    expect(byName.get('xlooop.get_current_work')!.build({})).toEqual({ method: 'GET', path: '/api/v1/mcp/current-work' });
    expect(byName.get('xlooop.list_events')!.build({ limit: 500, before: 'evt_x' }))
      .toEqual({ method: 'GET', path: '/api/v1/mcp/events?limit=100&before=evt_x' }); // cap enforced
    expect(byName.get('xlooop.get_plan')!.build({})).toEqual({ error: 'scope_id is required' });
    expect(byName.get('xlooop.get_plan')!.build({ scope_id: 'prj 1' })).toEqual({ method: 'GET', path: '/api/v1/mcp/plan/prj%201' });
    expect(byName.get('xlooop.get_evidence')!.build({})).toEqual({ error: 'packet_id is required' });
    expect(byName.get('xlooop.list_receipts')!.build({ limit: 9999 })).toEqual({ method: 'GET', path: '/api/v1/mcp/receipts?limit=200' });
  });
});
