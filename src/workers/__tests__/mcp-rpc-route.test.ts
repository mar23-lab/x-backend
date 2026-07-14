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
    expect(j.result.capabilities.tools).toBeTruthy();
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
    expect(j.tools).toContain('xlooop.whoami');
  });
});
