// operational-spine-route.test.ts
//
// Route tests for the backend-first operational spine. DAL is mocked so these
// tests assert route policy and payload contract without touching live Neon.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { operationalSpineRoute } from '../routes/operational-spine';

const ENV = { DATABASE_URL: 'x' };
const OPERATOR = { user_id: 'user_op', role: 'operator', workspace_id: 'tenant_a' };
const VIEWER = { user_id: 'user_viewer', role: 'viewer', workspace_id: 'tenant_a' };
const CANARY_LIFECYCLE = {
  user_id: 'svc_xlooop_canary_lifecycle',
  role: 'operator',
  workspace_id: 'tenant_a',
  service_principal: 'canary_lifecycle',
};

type Call = { method: string; ws: string; actor?: string; input?: Record<string, unknown>; id?: string };

function appFor(auth: Record<string, unknown>, calls: Call[], opts?: { missingApproval?: boolean; completionFlag?: string; missingPacket?: boolean }) {
  const dal = {
    listTaskPackets: async (ws: string) => {
      calls.push({ method: 'listTaskPackets', ws });
      return [{ id: 'pkt_1', workspace_id: ws, title: 'Packet', summary: 'Scoped', allowed_tools: [], forbidden_tools: [] }];
    },
    createTaskPacket: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createTaskPacket', ws, actor, input });
      return { id: 'pkt_new', workspace_id: ws, actor_user_id: actor, ...input };
    },
    evaluateTaskPacketCompletion: async (ws: string, id: string) => {
      calls.push({ method: 'evaluateTaskPacketCompletion', ws, id });
      if (opts?.missingPacket) return null;
      return { packet_id: id, packet_version: 2, can_complete: false, unmet_reasons: ['approval_missing'], facts: {} };
    },
    listEvidenceItems: async (ws: string) => {
      calls.push({ method: 'listEvidenceItems', ws });
      return [];
    },
    createEvidenceItem: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createEvidenceItem', ws, actor, input });
      return { id: 'ev_1', workspace_id: ws, actor_user_id: actor, ...input };
    },
    listApprovalRequests: async (ws: string) => {
      calls.push({ method: 'listApprovalRequests', ws });
      return [];
    },
    createApprovalRequest: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createApprovalRequest', ws, actor, input });
      return { id: 'apr_1', workspace_id: ws, requested_by: actor, status: 'requested', ...input };
    },
    decideApprovalRequest: async (ws: string, id: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'decideApprovalRequest', ws, id, actor, input });
      if (opts?.missingApproval) return null;
      return { id, workspace_id: ws, decided_by: actor, ...input };
    },
    listToolEvents: async (ws: string) => {
      calls.push({ method: 'listToolEvents', ws });
      return [];
    },
    createToolEvent: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createToolEvent', ws, actor, input });
      return { id: 'te_1', workspace_id: ws, actor_user_id: actor, ...input };
    },
    listMetricDeltas: async (ws: string) => {
      calls.push({ method: 'listMetricDeltas', ws });
      return [];
    },
    createMetricDelta: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createMetricDelta', ws, actor, input });
      return { id: 'md_1', workspace_id: ws, recorded_by: actor, ...input };
    },
    executeCustomerDataLifecycleRequest: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'executeCustomerDataLifecycleRequest', ws, actor, input });
      return {
        request_kind: input.request_kind,
        status: 'executed',
        approval_id: input.approval_id,
        target_packet_id: input.target_packet_id ?? null,
        archived_packet_ids: input.request_kind === 'delete' ? [String(input.target_packet_id)] : [],
        evidence_item: { id: 'ev_receipt', workspace_id: ws },
        tool_event: { id: 'te_receipt', workspace_id: ws },
      };
    },
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', operationalSpineRoute);
  return { app, env: { ...ENV, PACKET_COMPLETION_EVALUATION_ENABLED: opts?.completionFlag } };
}

function request(
  method: string,
  path: string,
  auth: Record<string, unknown>,
  body?: Record<string, unknown>,
  opts?: { missingApproval?: boolean },
) {
  const calls: Call[] = [];
  const built = appFor(auth, calls, opts);
  return built.app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, built.env as never).then((res) => ({ res, calls }));
}

describe('operational spine routes', () => {
  it('GET /packets is workspace-scoped', async () => {
    const { res, calls } = await request('GET', '/packets', OPERATOR);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: 'listTaskPackets', ws: 'tenant_a' }]);
  });

  it('completion evaluation is default-off and does not touch the DAL', async () => {
    const { res, calls } = await request('GET', '/packets/pkt_1/completion-evaluation', OPERATOR);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('FEATURE_DISABLED');
    expect(calls).toEqual([]);
  });

  it('completion evaluation is server-derived and workspace-scoped when explicitly enabled', async () => {
    const { res, calls } = await request('GET', '/packets/pkt_1/completion-evaluation', OPERATOR, undefined, { completionFlag: 'true' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: 'evaluateTaskPacketCompletion', ws: 'tenant_a', id: 'pkt_1' }]);
    expect((await res.json()).evaluation).toMatchObject({ packet_id: 'pkt_1', packet_version: 2, can_complete: false });
  });

  it('completion evaluation does not enumerate another tenant packet', async () => {
    const { res, calls } = await request('GET', '/packets/pkt_other/completion-evaluation', OPERATOR, undefined, { completionFlag: 'true', missingPacket: true });
    expect(res.status).toBe(404);
    expect(calls).toEqual([{ method: 'evaluateTaskPacketCompletion', ws: 'tenant_a', id: 'pkt_other' }]);
  });

  it('POST /packets permits operator and ignores any forged workspace field', async () => {
    const { res, calls } = await request('POST', '/packets', OPERATOR, {
      workspace_id: 'tenant_b',
      title: 'Scoped task',
      summary: 'Do safe scoped work',
      allowed_tools: ['get_task_packet'],
    });
    expect(res.status).toBe(201);
    expect(calls[0]).toMatchObject({ method: 'createTaskPacket', ws: 'tenant_a', actor: 'user_op' });
  });

  it('viewer cannot create packets, evidence, approvals, tool events, or metrics', async () => {
    const attempts = [
      request('POST', '/packets', VIEWER, { title: 'x', summary: 'x' }),
      request('POST', '/evidence', VIEWER, { kind: 'link', title: 'x', uri: 'https://example.com' }),
      request('POST', '/approvals', VIEWER, { reason: 'review' }),
      request('POST', '/tool-events', VIEWER, { tool_name: 'mcp', action: 'report_tool_event', status: 'completed', summary: 'x' }),
      request('POST', '/metric-deltas', VIEWER, { metric_id: 'production.coherence', before_value: 1, after_value: 2 }),
      request('POST', '/customer-data/export-requests', VIEWER, { reason: 'export' }),
      request('POST', '/customer-data/delete-requests', VIEWER, { reason: 'delete', target_packet_id: 'pkt_1' }),
      request('POST', '/customer-data/delete-requests/apr_1/execute', VIEWER, { target_packet_id: 'pkt_1' }),
    ];
    const results = await Promise.all(attempts);
    for (const { res, calls } of results) {
      expect(res.status).toBe(403);
      expect(calls).toEqual([]);
    }
  });

  it('canary lifecycle token can only write canary-scoped metadata lifecycle rows', async () => {
    const safeEvidence = await request('POST', '/evidence', CANARY_LIFECYCLE, {
      packet_id: 'pkt-canary-unit',
      kind: 'log',
      title: 'Canary evidence',
      uri: 'xlooop://canary/unit/evidence',
      summary: 'metadata-only canary evidence',
      redaction_status: 'metadata_only',
    });
    expect(safeEvidence.res.status).toBe(201);
    expect(safeEvidence.calls[0]).toMatchObject({
      method: 'createEvidenceItem',
      ws: 'tenant_a',
      actor: 'svc_xlooop_canary_lifecycle',
    });

    const unsafePacket = await request('POST', '/evidence', CANARY_LIFECYCLE, {
      packet_id: 'pkt_real_customer',
      kind: 'log',
      title: 'bad',
      uri: 'xlooop://canary/unit/evidence',
      redaction_status: 'metadata_only',
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

    const unsafeMetric = await request('POST', '/metric-deltas', CANARY_LIFECYCLE, {
      packet_id: 'pkt-canary-unit',
      metric_id: 'production.launch_score',
      before_value: 0,
      after_value: 1,
    });
    expect(unsafeMetric.res.status).toBe(403);
    expect(unsafeMetric.calls).toEqual([]);
  });

  it('canary lifecycle token cannot execute customer data lifecycle actions', async () => {
    const exportRequest = await request('POST', '/customer-data/export-requests', CANARY_LIFECYCLE, {
      reason: 'not allowed',
      target_packet_id: 'pkt-canary-unit',
    });
    const deleteRequest = await request('POST', '/customer-data/delete-requests', CANARY_LIFECYCLE, {
      reason: 'not allowed',
      target_packet_id: 'pkt-canary-unit',
    });
    const deleteExecution = await request('POST', '/customer-data/delete-requests/apr_1/execute', CANARY_LIFECYCLE, {
      target_packet_id: 'pkt-canary-unit',
    });
    expect(exportRequest.res.status).toBe(403);
    expect(deleteRequest.res.status).toBe(403);
    expect(deleteExecution.res.status).toBe(403);
    expect(exportRequest.calls).toEqual([]);
    expect(deleteRequest.calls).toEqual([]);
    expect(deleteExecution.calls).toEqual([]);
  });

  it('POST /evidence enforces allowed evidence kind', async () => {
    const { res, calls } = await request('POST', '/evidence', OPERATOR, {
      kind: 'raw_graph',
      title: 'bad',
      uri: 'graph://raw',
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('POST /tool-events enforces the safe MCP action allowlist', async () => {
    const { res, calls } = await request('POST', '/tool-events', OPERATOR, {
      tool_name: 'mcp',
      action: 'search_all_memory',
      status: 'completed',
      summary: 'unsafe',
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('PATCH /approvals/:id decides an approval request once', async () => {
    const { res, calls } = await request('PATCH', '/approvals/apr_1', OPERATOR, {
      status: 'approved',
      decision_comment: 'ok',
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({
      method: 'decideApprovalRequest',
      ws: 'tenant_a',
      id: 'apr_1',
      actor: 'user_op',
    });
  });

  it('PATCH /approvals/:id returns 404 when missing or already decided', async () => {
    const { res } = await request('PATCH', '/approvals/apr_missing', OPERATOR, {
      status: 'approved',
    }, { missingApproval: true });
    expect(res.status).toBe(404);
  });

  it('POST /customer-data/export-requests creates an approval-bound metadata export request', async () => {
    const { res, calls } = await request('POST', '/customer-data/export-requests', OPERATOR, {
      reason: 'customer asked for their workspace export',
      target_packet_id: 'pkt_1',
    });
    expect(res.status).toBe(201);
    expect(calls[0]).toMatchObject({
      method: 'createApprovalRequest',
      ws: 'tenant_a',
      actor: 'user_op',
      input: { packet_id: 'pkt_1' },
    });
    expect((calls[0]?.input?.reason as string)).toContain('[customer_data_lifecycle:export]');
  });

  it('POST /customer-data/delete-requests requires a target packet and creates an approval request', async () => {
    const missing = await request('POST', '/customer-data/delete-requests', OPERATOR, { reason: 'delete' });
    expect(missing.res.status).toBe(400);
    expect(missing.calls).toEqual([]);

    const { res, calls } = await request('POST', '/customer-data/delete-requests', OPERATOR, {
      reason: 'delete requested customer packet',
      target_packet_id: 'pkt_1',
    });
    expect(res.status).toBe(201);
    expect(calls[0]).toMatchObject({
      method: 'createApprovalRequest',
      ws: 'tenant_a',
      actor: 'user_op',
      input: { packet_id: 'pkt_1' },
    });
    expect((calls[0]?.input?.reason as string)).toContain('[customer_data_lifecycle:delete]');
  });

  it('POST /customer-data/delete-requests/:approval_id/execute executes through workspace-scoped DAL', async () => {
    const { res, calls } = await request('POST', '/customer-data/delete-requests/apr_1/execute', OPERATOR, {
      target_packet_id: 'pkt_1',
      execution_note: 'owner-approved test execution',
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({
      method: 'executeCustomerDataLifecycleRequest',
      ws: 'tenant_a',
      actor: 'user_op',
      input: {
        approval_id: 'apr_1',
        request_kind: 'delete',
        target_packet_id: 'pkt_1',
        execution_note: 'owner-approved test execution',
      },
    });
  });
});
