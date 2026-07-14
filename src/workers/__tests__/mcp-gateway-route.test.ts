// mcp-gateway-route.test.ts
//
// Tests the safe MCP-style gateway contract: clients get signed scoped packets
// and can only report evidence, tool events, approvals, and status through the
// tenant-scoped operational spine.

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mcpGatewayRoute } from '../routes/mcp-gateway';

const ENV = {
  DATABASE_URL: 'x',
  OPERATIONAL_SPINE_PACKET_SIGNING_SECRET: 'unit-test-signing-secret',
};
const OPERATOR = { user_id: 'user_op', role: 'operator', workspace_id: 'tenant_a' };
const VIEWER = { user_id: 'user_viewer', role: 'viewer', workspace_id: 'tenant_a' };
const CANARY_LIFECYCLE = {
  user_id: 'svc_xlooop_canary_lifecycle',
  role: 'operator',
  workspace_id: 'tenant_a',
  service_principal: 'canary_lifecycle',
};

type Call = { method: string; ws: string; actor?: string; input?: Record<string, unknown>; opts?: Record<string, unknown> };

const PACKET = {
  id: 'pkt_1',
  workspace_id: 'tenant_a',
  project_id: null,
  event_id: null,
  title: 'Scoped task',
  summary: 'Only safe tools',
  lifecycle_state: 'ready',
  actor_user_id: 'user_op',
  allowed_tools: ['xlooop.submit_evidence', 'xlooop.report_tool_event'],
  forbidden_tools: ['search_all_memory'],
  source_refs: ['src://redacted'],
  evidence_ref_ids: [],
  approval_required: true,
  expires_at: null,
  created_at: '2026-06-18T00:00:00.000Z',
  updated_at: '2026-06-18T00:00:00.000Z',
};

function appFor(auth: Record<string, unknown>, calls: Call[], opts?: { missingPacket?: boolean; noSigningSecret?: boolean }) {
  const dal = {
    listTaskPackets: async (ws: string, listOpts: Record<string, unknown>) => {
      calls.push({ method: 'listTaskPackets', ws, opts: listOpts });
      return opts?.missingPacket ? [] : [PACKET];
    },
    listEvidenceItems: async (ws: string, listOpts: Record<string, unknown>) => {
      calls.push({ method: 'listEvidenceItems', ws, opts: listOpts });
      return [{ id: 'ev_1', workspace_id: ws, packet_id: 'pkt_1' }];
    },
    createEvidenceItem: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createEvidenceItem', ws, actor, input });
      return { id: 'ev_1', workspace_id: ws, actor_user_id: actor, ...input };
    },
    listApprovalRequests: async (ws: string, listOpts: Record<string, unknown>) => {
      calls.push({ method: 'listApprovalRequests', ws, opts: listOpts });
      return [{ id: 'apr_1', workspace_id: ws, packet_id: 'pkt_1' }];
    },
    createApprovalRequest: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createApprovalRequest', ws, actor, input });
      return { id: 'apr_1', workspace_id: ws, requested_by: actor, status: 'requested', ...input };
    },
    listToolEvents: async (ws: string, listOpts: Record<string, unknown>) => {
      calls.push({ method: 'listToolEvents', ws, opts: listOpts });
      return [{ id: 'te_1', workspace_id: ws, packet_id: 'pkt_1' }];
    },
    createToolEvent: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createToolEvent', ws, actor, input });
      return { id: 'te_1', workspace_id: ws, actor_user_id: actor, ...input };
    },
    listMetricDeltas: async (ws: string, listOpts: Record<string, unknown>) => {
      calls.push({ method: 'listMetricDeltas', ws, opts: listOpts });
      return [{ id: 'md_1', workspace_id: ws, packet_id: 'pkt_1' }];
    },
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1/mcp', mcpGatewayRoute);
  return {
    app,
    env: opts?.noSigningSecret
      ? { DATABASE_URL: 'x' }
      : ENV,
  };
}

function request(
  method: string,
  path: string,
  auth: Record<string, unknown>,
  body?: Record<string, unknown>,
  opts?: { missingPacket?: boolean; noSigningSecret?: boolean },
) {
  const calls: Call[] = [];
  const { app, env } = appFor(auth, calls, opts);
  return app.request(`/api/v1/mcp${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, env as never).then((res) => ({ res, calls }));
}

describe('safe MCP gateway routes', () => {
  it('GET /tools exposes only safe scoped tools and explicit forbidden surfaces', async () => {
    const { res } = await request('GET', '/tools', VIEWER);
    expect(res.status).toBe(200);
    const body = await res.json() as { connector_namespace: string; tools: Array<{ name: string }>; forbidden_surfaces: string[] };
    expect(body.connector_namespace).toBe('xlooop-customer-gateway');
    expect(body.tools.map((tool) => tool.name)).toEqual([
      'xlooop.whoami',
      'xlooop.get_task_packet',
      'xlooop.get_effective_templates',
      'xlooop.get_effective_profile',
      'xlooop.submit_learning_signal',
      'xlooop.submit_evidence',
      'xlooop.report_tool_event',
      'xlooop.request_approval',
      'xlooop.get_workflow_status',
      'xlooop.list_sources',
      'xlooop.get_evidence',
      'xlooop.list_receipts',
      'xlooop.get_document',
    ]);
    expect(body.forbidden_surfaces).toContain('raw_graph');
    expect(body.forbidden_surfaces).toContain('search_all_memory');
    expect(body.forbidden_surfaces).toContain('graph_authority');
  });

  it('GET /whoami returns redacted identity binding for API/MCP customers', async () => {
    const { res } = await request('GET', '/whoami', VIEWER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      schema_id: string;
      connector_namespace: string;
      identity: { user_id: string; tenant_id: string; role: string; auth_method: string };
      allowed_tools: Array<{ name: string }>;
      forbidden_surfaces: string[];
    };
    expect(body.schema_id).toBe('xlooop.mcp_whoami.v1');
    expect(body.connector_namespace).toBe('xlooop-customer-gateway');
    expect(body.identity).toMatchObject({
      user_id: 'user_viewer',
      tenant_id: 'tenant_a',
      role: 'viewer',
      auth_method: 'clerk_jwt',
    });
    expect(body.allowed_tools.map((tool) => tool.name)).toContain('xlooop.whoami');
    expect(body.forbidden_surfaces).toContain('governance_scoring');
  });

  it('GET /task-packets/:id returns a signed scoped packet envelope', async () => {
    const { res, calls } = await request('GET', '/task-packets/pkt_1', VIEWER);
    expect(res.status).toBe(200);
    const body = await res.json() as { schema_id: string; signature: { alg: string; value: string }; blocked_surfaces: string[] };
    expect(body.schema_id).toBe('xlooop.mcp_task_packet_envelope.v1');
    expect(body.signature.alg).toBe('HS256');
    expect(body.signature.value.length).toBeGreaterThan(20);
    expect(body.blocked_surfaces).toContain('full_tenant_memory');
    expect(calls[0]).toMatchObject({ method: 'listTaskPackets', ws: 'tenant_a', opts: { packet_id: 'pkt_1', limit: 1 } });
  });

  it('GET /task-packets/:id fails closed when signing is not configured', async () => {
    const { res, calls } = await request('GET', '/task-packets/pkt_1', VIEWER, undefined, { noSigningSecret: true });
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('GET /status returns packet-scoped evidence, approvals, tool events, and metrics', async () => {
    const { res, calls } = await request('GET', '/status?packet_id=pkt_1', VIEWER);
    expect(res.status).toBe(200);
    expect(calls.map((call) => call.method)).toEqual([
      'listTaskPackets',
      'listEvidenceItems',
      'listApprovalRequests',
      'listToolEvents',
      'listMetricDeltas',
    ]);
    for (const call of calls) expect(call.ws).toBe('tenant_a');
  });

  it('viewer cannot submit evidence, report tool events, or request approval', async () => {
    const attempts = [
      request('POST', '/evidence', VIEWER, { packet_id: 'pkt_1', kind: 'link', title: 'Evidence', uri: 'https://example.com' }),
      request('POST', '/tool-events', VIEWER, { packet_id: 'pkt_1', tool_name: 'xlooop.report_tool_event', action: 'report_tool_event', status: 'completed', summary: 'x' }),
      request('POST', '/approval-requests', VIEWER, { packet_id: 'pkt_1', reason: 'Need approval' }),
    ];
    const results = await Promise.all(attempts);
    for (const { res, calls } of results) {
      expect(res.status).toBe(403);
      expect(calls).toEqual([]);
    }
  });

  it('operator can use safe write tools through the gateway', async () => {
    const evidence = await request('POST', '/evidence', OPERATOR, {
      packet_id: 'pkt_1',
      kind: 'link',
      title: 'Receipt',
      uri: 'https://example.com/receipt',
      redaction_status: 'metadata_only',
    });
    const toolEvent = await request('POST', '/tool-events', OPERATOR, {
      packet_id: 'pkt_1',
      tool_name: 'xlooop.report_tool_event',
      action: 'report_tool_event',
      status: 'completed',
      summary: 'reported',
    });
    const approval = await request('POST', '/approval-requests', OPERATOR, {
      packet_id: 'pkt_1',
      reason: 'execute external write',
    });
    expect(evidence.res.status).toBe(201);
    expect(toolEvent.res.status).toBe(201);
    expect(approval.res.status).toBe(201);
  });

  it('canary lifecycle token can only write canary packet metadata through MCP', async () => {
    const safe = await request('POST', '/evidence', CANARY_LIFECYCLE, {
      packet_id: 'pkt-canary-unit',
      kind: 'log',
      title: 'Canary MCP evidence',
      uri: 'xlooop://canary/unit/mcp-evidence',
      redaction_status: 'metadata_only',
    });
    expect(safe.res.status).toBe(201);
    expect(safe.calls[0]).toMatchObject({
      method: 'createEvidenceItem',
      ws: 'tenant_a',
      actor: 'svc_xlooop_canary_lifecycle',
    });

    const unsafePacket = await request('POST', '/tool-events', CANARY_LIFECYCLE, {
      packet_id: 'pkt_customer',
      tool_name: 'xlooop.report_tool_event',
      action: 'report_tool_event',
      status: 'completed',
      summary: 'bad',
    });
    expect(unsafePacket.res.status).toBe(403);
    expect(unsafePacket.calls).toEqual([]);

    const unsafeEvidence = await request('POST', '/evidence', CANARY_LIFECYCLE, {
      packet_id: 'pkt-canary-unit',
      kind: 'log',
      title: 'bad',
      uri: 'https://example.com/raw',
      redaction_status: 'not_required',
    });
    expect(unsafeEvidence.res.status).toBe(403);
    expect(unsafeEvidence.calls).toEqual([]);
  });

  it('requires tool events to be packet-bound', async () => {
    const toolEvent = await request('POST', '/tool-events', OPERATOR, {
      tool_name: 'xlooop.report_tool_event',
      action: 'report_tool_event',
      status: 'completed',
      summary: 'unbound event',
    });
    expect(toolEvent.res.status).toBe(400);
    expect(toolEvent.calls).toEqual([]);
  });

  it('rejects raw evidence and search-all-memory tool events', async () => {
    const rawEvidence = await request('POST', '/evidence', OPERATOR, {
      packet_id: 'pkt_1',
      kind: 'raw_graph',
      title: 'bad',
      uri: 'graph://raw',
    });
    const unsafeTool = await request('POST', '/tool-events', OPERATOR, {
      packet_id: 'pkt_1',
      tool_name: 'xlooop.search_all_memory',
      action: 'search_all_memory',
      status: 'completed',
      summary: 'bad',
    });
    expect(rawEvidence.res.status).toBe(400);
    expect(rawEvidence.calls).toEqual([]);
    expect(unsafeTool.res.status).toBe(400);
    expect(unsafeTool.calls).toEqual([]);
  });
});
