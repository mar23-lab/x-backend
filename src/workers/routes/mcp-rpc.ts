// mcp-rpc.ts · hosted Model Context Protocol (Streamable HTTP / JSON-RPC 2.0) endpoint.
//
// This is the native-connector surface: `claude mcp add --transport http
// https://api.xlooop.com/api/v1/mcp/rpc --header "Authorization: Bearer <token>"`.
// It is a THIN protocol adapter — it does NOT re-implement any tool. Each tools/call is
// dispatched, with the caller's own Authorization header, back through the same authenticated
// REST handlers that back the safe MCP gateway (mcp-gateway.ts + template-policy-registry.ts), so
// the customer allowlist, tenant scope, forbidden surfaces, signing, and revocation are all
// single-sourced. No new dependency: JSON-RPC is implemented inline (keeps the worker lean).
//
// Auth: mounted under the operational route group (clerkAuth allowCanary + allowCustomerToken), so
// the Bearer customer connector token authenticates initialize / tools/list / tools/call uniformly.

import { Hono } from 'hono';
import type { AuthEnv, AuthVariables } from '../middleware/auth';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export const MCP_SERVER_INFO = { name: 'xlooop-customer-gateway', version: '1.0.0' } as const;

// The customer-safe read tools exposed over MCP. Each maps to an existing authenticated REST
// handler (path verbatim from mcp-gateway SAFE_TOOLS / template-policy routes). Write tools are
// intentionally NOT exposed here yet — they stay on the REST gateway behind canWrite + the
// per-customer write sandbox until the operational connector is signed off.
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  build: (args: Record<string, unknown>) => { method: 'GET'; path: string } | { error: string };
}

const STRING = (required: string[] = []) => ({
  type: 'object',
  properties: {} as Record<string, unknown>,
  required,
  additionalProperties: false,
});

function reqString(args: Record<string, unknown>, key: string): string | null {
  const v = args?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export const MCP_READ_TOOLS: McpToolDef[] = [
  {
    name: 'xlooop.whoami',
    description: 'Confirm the connected customer identity, workspace, and the read-only tool allowlist.',
    inputSchema: STRING(),
    build: () => ({ method: 'GET', path: '/api/v1/mcp/whoami' }),
  },
  {
    name: 'xlooop.get_task_packet',
    description: 'Read one tenant-scoped, signed task packet by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task packet id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    build: (args) => {
      const id = reqString(args, 'id');
      return id ? { method: 'GET', path: `/api/v1/mcp/task-packets/${encodeURIComponent(id)}` } : { error: 'id is required' };
    },
  },
  {
    name: 'xlooop.get_workflow_status',
    description: 'Read workflow status (evidence, approvals, tool events, metric deltas) for an allowed packet.',
    inputSchema: {
      type: 'object',
      properties: { packet_id: { type: 'string', description: 'Task packet id.' } },
      required: ['packet_id'],
      additionalProperties: false,
    },
    build: (args) => {
      const pid = reqString(args, 'packet_id');
      return pid ? { method: 'GET', path: `/api/v1/mcp/status?packet_id=${encodeURIComponent(pid)}` } : { error: 'packet_id is required' };
    },
  },
  {
    name: 'xlooop.get_effective_templates',
    description: 'Read the redacted effective template snapshots for this workspace.',
    inputSchema: STRING(),
    build: () => ({ method: 'GET', path: '/api/v1/template-policy/effective-snapshots' }),
  },
  {
    name: 'xlooop.get_effective_profile',
    description: 'Read the effective personalization profile for this workspace/user.',
    inputSchema: STRING(),
    build: () => ({ method: 'GET', path: '/api/v1/template-policy/personalization/effective-profile' }),
  },
];

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function result(id: JsonRpcId, value: unknown) {
  return { jsonrpc: '2.0', id, result: value };
}
function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Dispatch a tool's underlying REST call back through the full app pipeline, forwarding the
 * caller's Authorization header so auth/tenant-scope/allowlist are enforced identically.
 */
export type AppDispatch = (request: Request, ctx: any) => Promise<Response>;

export function createMcpRpcRoute(dispatch: AppDispatch) {
  const route = new Hono<{ Bindings: AuthEnv; Variables: AuthVariables }>();

  async function handleOne(ctx: any, msg: JsonRpcRequest): Promise<object | null> {
    const id: JsonRpcId = msg.id ?? null;
    const method = msg.method;

    // Notifications (no id) — acknowledge without a response body.
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;

    if (method === 'initialize') {
      const requested = (msg.params?.protocolVersion as string) || DEFAULT_PROTOCOL_VERSION;
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      return result(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          'Xlooop customer connector. Read-only, tenant-scoped. Call xlooop.whoami first to confirm identity.',
      });
    }

    if (method === 'ping') return result(id, {});

    if (method === 'tools/list') {
      return result(id, {
        tools: MCP_READ_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    if (method === 'tools/call') {
      const name = (msg.params?.name as string) || '';
      const args = (msg.params?.arguments as Record<string, unknown>) || {};
      const tool = MCP_READ_TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `unknown or non-allowed tool: ${name || '(none)'}`);
      const built = tool.build(args);
      if ('error' in built) return rpcError(id, -32602, built.error);

      const origin = new URL(ctx.req.url).origin;
      const headers = new Headers();
      const auth = ctx.req.header('authorization') || ctx.req.header('Authorization');
      if (auth) headers.set('Authorization', auth);
      headers.set('Accept', 'application/json');

      let payload: unknown;
      let ok: boolean;
      try {
        const resp = await dispatch(new Request(origin + built.path, { method: built.method, headers }), ctx);
        ok = resp.ok;
        payload = await resp.json().catch(() => ({ error: 'non-JSON response', code: 'INTERNAL_ERROR' }));
      } catch (err) {
        ok = false;
        payload = { error: err instanceof Error ? err.message : 'dispatch failed', code: 'INTERNAL_ERROR' };
      }
      return result(id, {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: !ok,
      });
    }

    return rpcError(id, -32601, `method not found: ${method || '(none)'}`);
  }

  route.post('/rpc', async (ctx) => {
    const body = await ctx.req.json().catch(() => null);
    if (body === null) {
      ctx.status(400);
      return ctx.json(rpcError(null, -32700, 'parse error: body is not valid JSON'));
    }

    // MCP Streamable HTTP allows a single message or a batch array.
    if (Array.isArray(body)) {
      const responses = [];
      for (const msg of body) {
        const r = await handleOne(ctx, msg as JsonRpcRequest);
        if (r) responses.push(r);
      }
      if (responses.length === 0) {
        ctx.status(202);
        return ctx.body(null);
      }
      return ctx.json(responses);
    }

    const r = await handleOne(ctx, body as JsonRpcRequest);
    if (r === null) {
      ctx.status(202);
      return ctx.body(null);
    }
    return ctx.json(r);
  });

  // Discovery convenience: GET advertises the transport so a misconfigured client gets a hint.
  route.get('/rpc', (ctx) =>
    ctx.json({
      schema_id: 'xlooop.mcp_rpc_descriptor.v1',
      transport: 'streamable-http',
      protocol_versions: MCP_PROTOCOL_VERSIONS,
      server_info: MCP_SERVER_INFO,
      hint: 'POST JSON-RPC 2.0 here (initialize, tools/list, tools/call). Send Authorization: Bearer <connector-token>.',
      tools: MCP_READ_TOOLS.map((t) => t.name),
    }),
  );

  return route;
}
