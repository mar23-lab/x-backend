// mcp-gateway.ts · safe execution gateway for scoped packets and evidence.
//
// This is not a raw graph or memory API. MCP-style clients receive signed,
// tenant-scoped task packets, then report evidence, tool events, approvals, and
// status against the operational spine.

import { Hono } from 'hono';
import { envFlagTrue } from '../lib/env-flag';
import { authorizeSpineWrite } from '../lib/spine-authority';
import { idempotencyMiddleware } from '../lib/idempotency';
import { lineageFor } from '../lib/actor-lineage';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type {
  AuthContext,
  EvidenceKind,
  TaskPacket,
  ToolEventAction,
} from '../dal/types';
import { evaluateUgecFence } from '../lib/ugec-fence';
import { whoamiEnvelope } from './template-policy-registry';
import { emitEvent } from '../lib/observability'; // T3/P6 · structured events for the landed writes
import { mcpCustomerReadsRoute } from './mcp-customer-reads'; // T4/P7 · tenant-scoped customer-data reads

export interface McpGatewayEnv extends AuthEnv {
  OPERATIONAL_SPINE_PACKET_SIGNING_SECRET?: string;
  DATABASE_URL?: string;
  IDEMPOTENCY_ENABLED?: string;
}

export interface McpGatewayVariables extends AuthVariables {
  dal: DalAdapter;
}

export const mcpGatewayRoute = new Hono<{
  Bindings: McpGatewayEnv;
  Variables: McpGatewayVariables;
}>();

// J-W1/IDEM-1 (260711-I): the group already IMPORTED idempotencyMiddleware but never applied it —
// so POST /evidence, /tool-events, /approval-requests (all append-only writes) were unwrapped. Apply
// it group-wide like operational-spine.ts:39 (flag-off ⇒ passthrough, byte-identical).
mcpGatewayRoute.use('*', idempotencyMiddleware());

export const CUSTOMER_MCP_CONNECTOR_NAMESPACE = 'xlooop-customer-gateway';

export const SAFE_TOOLS = [
  { name: 'xlooop.whoami', action: 'whoami', method: 'GET', path: '/api/v1/mcp/whoami' },
  { name: 'xlooop.get_task_packet', action: 'get_task_packet', method: 'GET', path: '/api/v1/mcp/task-packets/:id' },
  { name: 'xlooop.get_effective_templates', action: 'get_effective_templates', method: 'GET', path: '/api/v1/template-policy/effective-snapshots' },
  { name: 'xlooop.get_effective_profile', action: 'get_effective_profile', method: 'GET', path: '/api/v1/template-policy/personalization/effective-profile' },
  { name: 'xlooop.submit_learning_signal', action: 'submit_learning_signal', method: 'POST', path: '/api/v1/template-policy/personalization/signals' },
  { name: 'xlooop.submit_evidence', action: 'submit_evidence', method: 'POST', path: '/api/v1/mcp/evidence' },
  { name: 'xlooop.report_tool_event', action: 'report_tool_event', method: 'POST', path: '/api/v1/mcp/tool-events' },
  { name: 'xlooop.request_approval', action: 'request_approval', method: 'POST', path: '/api/v1/mcp/approval-requests' },
  { name: 'xlooop.get_workflow_status', action: 'get_workflow_status', method: 'GET', path: '/api/v1/mcp/status' },
  // T4/P7 (260710) · the tenant-scoped CUSTOMER-DATA READ surface (operator decision: reads only; the
  // sign-off WRITE waits for contract-confirm). Handlers live in ./mcp-customer-reads.ts.
  { name: 'xlooop.list_sources', action: 'list_sources', method: 'GET', path: '/api/v1/mcp/sources' },
  { name: 'xlooop.get_evidence', action: 'get_evidence', method: 'GET', path: '/api/v1/mcp/evidence' },
  { name: 'xlooop.list_receipts', action: 'list_receipts', method: 'GET', path: '/api/v1/mcp/receipts' },
  { name: 'xlooop.get_document', action: 'get_document', method: 'GET', path: '/api/v1/mcp/documents' },
] as const;

export const FORBIDDEN_SURFACES = [
  'raw_graph',
  'full_tenant_memory',
  'xlooop_internal_templates',
  'governance_scoring',
  'agent_routing',
  'private_graph_schema',
  'secrets',
  'search_all_memory',
  'mb_p_governance_internals',
  'graph_authority',
] as const;

const EVIDENCE_KINDS: ReadonlySet<EvidenceKind> = new Set([
  'document', 'screenshot', 'log', 'link', 'commit', 'metric', 'receipt',
]);

const TOOL_ACTIONS: ReadonlySet<ToolEventAction> = new Set([
  'get_task_packet',
  'get_allowed_scope',
  'submit_evidence',
  'report_tool_event',
  'request_approval',
  'get_workflow_status',
  'get_public_policy_summary',
  'get_effective_templates',
  'get_effective_profile',
  'submit_learning_signal',
]);

const TOOL_STATUSES = new Set(['allowed', 'denied', 'completed', 'failed']);
const REDACTION_STATUSES = new Set(['redacted', 'metadata_only', 'not_required']);

function isCanaryLifecycle(auth: AuthContext): boolean {
  return auth.service_principal === 'canary_lifecycle';
}

function ensureCanaryLifecycleWrite(
  ctx: any,
  auth: AuthContext,
  body: Record<string, unknown>,
  kind: 'evidence' | 'approval' | 'tool_event',
) {
  if (!isCanaryLifecycle(auth)) return null;
  const packetId = typeof body.packet_id === 'string' ? body.packet_id.trim() : '';
  if (!packetId.startsWith('pkt-canary-')) {
    return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle writes must target pkt-canary-* only');
  }
  if (kind === 'evidence' && String(body.redaction_status || '') !== 'metadata_only') {
    return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle evidence must be metadata_only');
  }
  if (kind === 'evidence' && typeof body.uri === 'string' && !body.uri.startsWith('xlooop://canary/')) {
    return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle evidence URI must use xlooop://canary/');
  }
  return null;
}

/**
 * Customer connector write sandbox. Operator-role customer tokens (service_principal ===
 * 'customer_token') may only write evidence/tool-events/approvals against task packets that live
 * in the token's own workspace. The write itself is already workspace-bound (createEvidenceItem
 * etc. use auth.workspace_id), so this is defense-in-depth + integrity: it rejects writes that
 * reference a packet outside the token's tenant. listTaskPackets is workspace-scoped (fail-closed),
 * so a foreign packet_id simply isn't found.
 */
async function ensureCustomerWriteScope(
  ctx: any,
  auth: AuthContext,
  packetId: string,
  toolAction?: string,
): Promise<Response | null> {
  if (auth.service_principal !== 'customer_token') return null;
  const [packet] = await ctx.get('dal').listTaskPackets(auth.workspace_id, {
    packet_id: packetId,
    limit: 1,
  });
  if (!packet) {
    return jsonError(ctx, 404, 'NOT_FOUND', 'task packet not found in your workspace');
  }
  // UGEC gap-2 (ADR-XB-008): the packet tool-fence + token packet_prefix scope, previously
  // declarative-only (signed into the envelope, never checked). Born-SHADOW: violations are
  // warn-logged; denial requires the explicit UGEC_FENCE_ENFORCEMENT flip. The fence must be
  // ENFORCED before CUSTOMER_API_TOKENS_ENABLED ever opens the agent door (fence-before-door).
  const violations = evaluateUgecFence({
    packet_id: packetId,
    packet_prefix: (auth as { packet_prefix?: string }).packet_prefix,
    allowed_tools: (packet as TaskPacket).allowed_tools,
    forbidden_tools: (packet as TaskPacket).forbidden_tools,
    action: toolAction,
  });
  if (violations.length > 0) {
    console.warn('[UGEC-FENCE]', JSON.stringify({
      workspace_id: auth.workspace_id,
      principal: auth.user_id,
      packet_id: packetId,
      action: toolAction ?? null,
      violations,
      enforced: envFlagTrue((ctx.env as { UGEC_FENCE_ENFORCEMENT?: string }).UGEC_FENCE_ENFORCEMENT),
    }));
    if (envFlagTrue((ctx.env as { UGEC_FENCE_ENFORCEMENT?: string }).UGEC_FENCE_ENFORCEMENT)) {
      return jsonError(ctx, 403, 'UGEC_FENCE_VIOLATION',
        `write blocked by the packet fence: ${violations.join(', ')}`);
    }
  }
  return null;
}

function jsonError(
  ctx: any,
  status: 400 | 403 | 404 | 410 | 503,
  code: string,
  error: string,
) {
  ctx.status(status);
  return ctx.json({ error, code, request_id: ctx.get('request_id') });
}

async function jsonBody(ctx: any): Promise<Record<string, unknown> | null> {
  const body = await ctx.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

function isExpired(packet: TaskPacket): boolean {
  return !!packet.expires_at && Date.parse(packet.expires_at) <= Date.now();
}

function packetSigningPayload(packet: TaskPacket, issuedAt: string): string {
  return JSON.stringify({
    schema_id: 'xlooop.mcp_task_packet_signature_payload.v1',
    packet_id: packet.id,
    workspace_id: packet.workspace_id,
    lifecycle_state: packet.lifecycle_state,
    allowed_tools: packet.allowed_tools,
    forbidden_tools: packet.forbidden_tools,
    evidence_ref_ids: packet.evidence_ref_ids,
    expires_at: packet.expires_at,
    updated_at: packet.updated_at,
    issued_at: issuedAt,
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signPacket(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64Url(new Uint8Array(signature));
}

mcpGatewayRoute.get('/tools', (ctx) => {
  return ctx.json({
    schema_id: 'xlooop.mcp_gateway_tools.v1',
    connector_namespace: CUSTOMER_MCP_CONNECTOR_NAMESPACE,
    tools: SAFE_TOOLS,
    forbidden_surfaces: FORBIDDEN_SURFACES,
  });
});

// T4/P7 · mount the customer-data READ tools on the same /mcp namespace + auth plane.
mcpGatewayRoute.route('/', mcpCustomerReadsRoute);

mcpGatewayRoute.get('/whoami', (ctx) => {
  return ctx.json({
    ...whoamiEnvelope(ctx.get('auth')),
    schema_id: 'xlooop.mcp_whoami.v1',
    connector_namespace: CUSTOMER_MCP_CONNECTOR_NAMESPACE,
    allowed_tools: SAFE_TOOLS,
  });
});

mcpGatewayRoute.get('/task-packets/:id', async (ctx) => {
  try {
    const secret = ctx.env.OPERATIONAL_SPINE_PACKET_SIGNING_SECRET;
    if (!secret) return jsonError(ctx, 503, 'SIGNING_UNCONFIGURED', 'packet signing secret is not configured');
    const { workspace_id } = ctx.get('auth');
    const [packet] = await ctx.get('dal').listTaskPackets(workspace_id, {
      packet_id: ctx.req.param('id'),
      limit: 1,
    });
    if (!packet) return jsonError(ctx, 404, 'NOT_FOUND', 'task packet not found');
    if (isExpired(packet)) return jsonError(ctx, 410, 'PACKET_EXPIRED', 'task packet is expired');

    const issued_at = new Date().toISOString();
    const signature_payload = packetSigningPayload(packet, issued_at);
    const signature = await signPacket(secret, signature_payload);
    return ctx.json({
      schema_id: 'xlooop.mcp_task_packet_envelope.v1',
      issued_at,
      packet,
      blocked_surfaces: FORBIDDEN_SURFACES,
      signature: {
        alg: 'HS256',
        value: signature,
      },
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

mcpGatewayRoute.get('/status', async (ctx) => {
  try {
    const { workspace_id } = ctx.get('auth');
    const packet_id = new URL(ctx.req.url).searchParams.get('packet_id') || undefined;
    if (!packet_id) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'packet_id query parameter is required');
    const dal = ctx.get('dal');
    const [packet] = await dal.listTaskPackets(workspace_id, { packet_id, limit: 1 });
    if (!packet) return jsonError(ctx, 404, 'NOT_FOUND', 'task packet not found');
    const [evidence, approvals, tool_events, metric_deltas] = await Promise.all([
      dal.listEvidenceItems(workspace_id, { packet_id, limit: 100 }),
      dal.listApprovalRequests(workspace_id, { packet_id, limit: 100 }),
      dal.listToolEvents(workspace_id, { packet_id, limit: 100 }),
      dal.listMetricDeltas(workspace_id, { packet_id, limit: 100 }),
    ]);
    return ctx.json({
      schema_id: 'xlooop.mcp_packet_status.v1',
      packet,
      evidence,
      approvals,
      tool_events,
      metric_deltas,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

mcpGatewayRoute.post('/evidence', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'evidence:submit')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit evidence submission');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    const canaryError = ensureCanaryLifecycleWrite(ctx, auth, body, 'evidence');
    if (canaryError) return canaryError;
    if (typeof body.packet_id !== 'string' || !body.packet_id.trim()) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'packet_id is required');
    }
    const evidenceScopeError = await ensureCustomerWriteScope(ctx, auth, body.packet_id);
    if (evidenceScopeError) return evidenceScopeError;
    if (!EVIDENCE_KINDS.has(body.kind as EvidenceKind)) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid evidence kind');
    }
    if (body.redaction_status && !REDACTION_STATUSES.has(String(body.redaction_status))) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid redaction_status');
    }
    const evidence = await ctx.get('dal').createEvidenceItem(workspace_id, user_id, body as never);
    emitEvent('evidence_created', { workspace_id, evidence_id: (evidence as { id?: string })?.id ?? null }); // T3/P6
    ctx.status(201);
    return ctx.json({ schema_id: 'xlooop.mcp_evidence_submission.v1', evidence });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

mcpGatewayRoute.post('/tool-events', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'tool_event:report')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit tool-event reporting');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    const canaryError = ensureCanaryLifecycleWrite(ctx, auth, body, 'tool_event');
    if (canaryError) return canaryError;
    if (typeof body.packet_id !== 'string' || !body.packet_id.trim()) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'packet_id is required');
    }
    const toolEventScopeError = await ensureCustomerWriteScope(ctx, auth, body.packet_id, String(body.action ?? ''));
    if (toolEventScopeError) return toolEventScopeError;
    if (!TOOL_ACTIONS.has(body.action as ToolEventAction)) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid tool action');
    }
    if (!TOOL_STATUSES.has(String(body.status))) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid tool-event status');
    }
    const tool_event = await ctx.get('dal').createToolEvent(workspace_id, user_id, body as never, {
      // W1 spine unification — SEPARATE param (never body-carried: the body is client-controlled).
      emitSpineEvent: envFlagTrue((ctx.env as { SPINE_TOOL_EVENT_UNIFICATION_ENABLED?: string }).SPINE_TOOL_EVENT_UNIFICATION_ENABLED),
      lineage: { ...lineageFor(auth as never), request_id: (ctx.get('request_id') as string | undefined) ?? null },
    });
    emitEvent('tool_event_reported', { workspace_id, tool_event_id: (tool_event as { id?: string })?.id ?? null }); // T3/P6
    ctx.status(201);
    return ctx.json({ schema_id: 'xlooop.mcp_tool_event_report.v1', tool_event });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

mcpGatewayRoute.post('/approval-requests', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'approval:request')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit approval requests');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    const canaryError = ensureCanaryLifecycleWrite(ctx, auth, body, 'approval');
    if (canaryError) return canaryError;
    if (typeof body.packet_id !== 'string' || !body.packet_id.trim()) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'packet_id is required');
    }
    const approvalScopeError = await ensureCustomerWriteScope(ctx, auth, body.packet_id);
    if (approvalScopeError) return approvalScopeError;
    if (typeof body.reason !== 'string' || !body.reason.trim()) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'reason is required');
    }
    const approval = await ctx.get('dal').createApprovalRequest(workspace_id, user_id, body as never);
    emitEvent('approval_requested', { workspace_id, approval_id: (approval as { id?: string })?.id ?? null }); // T3/P6
    ctx.status(201);
    return ctx.json({ schema_id: 'xlooop.mcp_approval_request.v1', approval });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
