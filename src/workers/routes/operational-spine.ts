// operational-spine.ts · packet/evidence/approval/tool-event/metric APIs
//
// Backend-first production spine. This route exposes scoped operational
// projections only; it never returns raw graph, full tenant memory, Xlooop
// internal templates, governance scoring, agent routing, private graph schema,
// secrets, or broad search-all-memory tools.

import { Hono } from 'hono';
import { envFlagTrue } from '../lib/env-flag';
import { authorizeSpineWrite } from '../lib/spine-authority';
import { idempotencyMiddleware } from '../lib/idempotency';
import { lineageFor } from '../lib/actor-lineage';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { resolveScopedWorkspace } from '../lib/operator-workspace-scope'; // JB 260714 · write-path operator-workspace-scope
import type {
  AuthContext,
  ApprovalDecisionInput,
  EvidenceKind,
  PacketLifecycleState,
  ToolEventAction,
} from '../dal/types';

export interface OperationalSpineEnv extends AuthEnv {
  DATABASE_URL: string;
  /** Wave-Y idempotency (default off ⇒ byte-identical, no dedupe). See lib/idempotency.ts. */
  IDEMPOTENCY_ENABLED?: string;
  /** Read-only completion-contract projection. Default off; migration 073 is required before enablement. */
  PACKET_COMPLETION_EVALUATION_ENABLED?: string;
}

export interface OperationalSpineVariables extends AuthVariables {
  dal: DalAdapter;
}

export const operationalSpineRoute = new Hono<{
  Bindings: OperationalSpineEnv;
  Variables: OperationalSpineVariables;
}>();

// Wave-Y: idempotency covers every mutating write in this group (flag-off ⇒ passthrough, byte-identical).
operationalSpineRoute.use('*', idempotencyMiddleware());

const PACKET_STATES: ReadonlySet<PacketLifecycleState> = new Set([
  'draft', 'ready', 'in_progress', 'evidence_ready', 'approval_requested',
  'approved', 'rejected', 'completed', 'archived',
]);

const EVIDENCE_KINDS: ReadonlySet<EvidenceKind> = new Set([
  'document', 'screenshot', 'log', 'link', 'commit', 'metric', 'receipt',
]);

const APPROVAL_DECISIONS: ReadonlySet<ApprovalDecisionInput['status']> = new Set([
  'approved', 'rejected', 'cancelled',
]);

const TOOL_ACTIONS: ReadonlySet<ToolEventAction> = new Set([
  'get_task_packet',
  'get_allowed_scope',
  'submit_evidence',
  'report_tool_event',
  'request_approval',
  'get_workflow_status',
  'get_public_policy_summary',
]);

const TOOL_STATUSES = new Set(['allowed', 'denied', 'completed', 'failed']);
const REDACTION_STATUSES = new Set(['redacted', 'metadata_only', 'not_required']);

function isCanaryLifecycle(auth: AuthContext): boolean {
  return auth.service_principal === 'canary_lifecycle';
}

function canaryPacketId(body: Record<string, unknown>): string {
  const value = body.packet_id ?? body.target_packet_id ?? body.id;
  return typeof value === 'string' ? value.trim() : '';
}

function ensureCanaryLifecycleWrite(
  ctx: any,
  auth: AuthContext,
  body: Record<string, unknown>,
  kind: 'packet' | 'evidence' | 'approval' | 'tool_event' | 'metric_delta',
) {
  if (!isCanaryLifecycle(auth)) return null;
  const packetId = canaryPacketId(body);
  if (!packetId.startsWith('pkt-canary-')) {
    return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle writes must target pkt-canary-* only');
  }
  if (kind === 'evidence' && String(body.redaction_status || '') !== 'metadata_only') {
    return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle evidence must be metadata_only');
  }
  if (kind === 'evidence' && typeof body.uri === 'string' && !body.uri.startsWith('xlooop://canary/')) {
    return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle evidence URI must use xlooop://canary/');
  }
  if (kind === 'metric_delta' && !String(body.metric_id || '').startsWith('canary.')) {
    return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle metrics must use canary.* metric ids');
  }
  return null;
}

function jsonError(ctx: any, status: 400 | 403 | 404, code: string, error: string) {
  ctx.status(status);
  return ctx.json({ error, code, request_id: ctx.get('request_id') });
}

function listOpts(ctx: any) {
  const url = new URL(ctx.req.url);
  const limitRaw = url.searchParams.get('limit');
  const packet_id = url.searchParams.get('packet_id') || undefined;
  return {
    limit: limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 50) : 50,
    ...(packet_id ? { packet_id } : {}),
  };
}

function lifecycleReason(kind: 'export' | 'delete', body: Record<string, unknown>): string {
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim()
    : `Customer ${kind} lifecycle request`;
  return [
    `[customer_data_lifecycle:${kind}]`,
    reason,
    'Requires approval before backend execution.',
    'Raw graph, full tenant memory, platform internals, governance scoring, secrets, and all-tenant search are forbidden.',
  ].join(' ');
}

async function jsonBody(ctx: any): Promise<Record<string, unknown> | null> {
  const body = await ctx.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

operationalSpineRoute.get('/packets', async (ctx) => {
  try {
    const { workspace_id } = ctx.get('auth');
    const packets = await ctx.get('dal').listTaskPackets(workspace_id, listOpts(ctx));
    return ctx.json({ packets });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.get('/packets/:id/completion-evaluation', async (ctx) => {
  try {
    if (!envFlagTrue(ctx.env.PACKET_COMPLETION_EVALUATION_ENABLED)) {
      return jsonError(ctx, 404, 'FEATURE_DISABLED', 'packet completion evaluation is not enabled');
    }
    const { workspace_id } = ctx.get('auth');
    const evaluation = await ctx.get('dal').evaluateTaskPacketCompletion(workspace_id, ctx.req.param('id'));
    if (!evaluation) return jsonError(ctx, 404, 'NOT_FOUND', 'packet not found');
    return ctx.json({ evaluation });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.post('/packets', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id: authWs, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'packet:create')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit packet creation');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    // JB (260714) · operator-workspace-scope for WRITES. Flag OFF (default) ⇒ authWs unconditionally
    // (byte-identical; body.workspace_id ignored). Flag ON ⇒ the workspace OWNER may direct this packet to a
    // workspace they own via body.workspace_id (requireOwner=true — stricter than reads); a non-owner
    // override is a hard 403 (never a silent write to the token org). This closes the write-side twin of the
    // JA read fix: reads followed the operator's selected workspace but writes still landed in the JWT org.
    const wsScoped = await resolveScopedWorkspace(
      ctx as never,
      (ctx.env as { OPERATOR_WORKSPACE_SCOPE_ENABLED?: string }).OPERATOR_WORKSPACE_SCOPE_ENABLED,
      authWs,
      user_id,
      typeof (body as { workspace_id?: unknown }).workspace_id === 'string' ? (body as { workspace_id?: string }).workspace_id! : null,
      ctx.get('dal'),
      true,
    );
    if (!wsScoped.ok) return wsScoped.res;
    const workspace_id = wsScoped.ws;
    const canaryError = ensureCanaryLifecycleWrite(ctx, auth, body, 'packet');
    if (canaryError) return canaryError;
    if (typeof body.title !== 'string' || typeof body.summary !== 'string') {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'title and summary are required');
    }
    // P3 (260714, Operability wave · G2 defense-in-depth): a governed packet needs a DESCRIBABLE intent.
    // Live incident 260714: bare chat words ("execute", "proceed") became junk packets titled
    // "Packet · execute". The wired adapter now guards client-side; this protects EVERY client.
    // Flag-gated so the rollout is operator-named; byte-identical when the flag is unset.
    if (envFlagTrue((ctx.env as { PACKET_INTENT_QUALITY_ENABLED?: string }).PACKET_INTENT_QUALITY_ENABLED)) {
      const t = body.title.trim();
      const bareVerb = /^(packet\s*·\s*)?(execute|executed|proceed|approve|approved|continue|go|go ahead|yes|ok|okay|do it|ship( it)?|run( it)?|next)[.!…]*$/i;
      if (t.length < 8 || !/\s/.test(t) || bareVerb.test(t)) {
        return jsonError(ctx, 400, 'VALIDATION_ERROR', 'intent_too_thin — describe the intent in a sentence (what should be produced, and for whom); a bare word cannot become a governed packet');
      }
    }
    if (body.lifecycle_state && !PACKET_STATES.has(body.lifecycle_state as PacketLifecycleState)) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid lifecycle_state');
    }
    const packet = await ctx.get('dal').createTaskPacket(workspace_id, user_id, body as never);
    ctx.status(201);
    return ctx.json({ packet });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.get('/evidence', async (ctx) => {
  try {
    const { workspace_id } = ctx.get('auth');
    const evidence = await ctx.get('dal').listEvidenceItems(workspace_id, listOpts(ctx));
    return ctx.json({ evidence });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.post('/evidence', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'evidence:submit')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit evidence submission');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    const canaryError = ensureCanaryLifecycleWrite(ctx, auth, body, 'evidence');
    if (canaryError) return canaryError;
    if (!EVIDENCE_KINDS.has(body.kind as EvidenceKind)) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid evidence kind');
    if (body.redaction_status && !REDACTION_STATUSES.has(String(body.redaction_status))) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid redaction_status');
    }
    const evidence = await ctx.get('dal').createEvidenceItem(workspace_id, user_id, body as never);
    ctx.status(201);
    return ctx.json({ evidence });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.get('/approvals', async (ctx) => {
  try {
    const { workspace_id } = ctx.get('auth');
    const approvals = await ctx.get('dal').listApprovalRequests(workspace_id, listOpts(ctx));
    return ctx.json({ approvals });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.post('/approvals', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'approval:request')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit approval requests');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    const canaryError = ensureCanaryLifecycleWrite(ctx, auth, body, 'approval');
    if (canaryError) return canaryError;
    if (typeof body.reason !== 'string' || !body.reason.trim()) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'reason is required');
    }
    const approval = await ctx.get('dal').createApprovalRequest(workspace_id, user_id, body as never);
    ctx.status(201);
    return ctx.json({ approval });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.patch('/approvals/:id', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, user_id } = auth;
    if (isCanaryLifecycle(auth)) return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle token cannot decide approvals');
    if (!(await authorizeSpineWrite(ctx, 'approval:decide')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit approval decisions');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    if (!APPROVAL_DECISIONS.has(body.status as ApprovalDecisionInput['status'])) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'status must be approved, rejected, or cancelled');
    }
    const approval = await ctx.get('dal').decideApprovalRequest(
      workspace_id,
      ctx.req.param('id'),
      user_id,
      body as never,
    );
    if (!approval) return jsonError(ctx, 404, 'NOT_FOUND', 'approval request not found or already decided');
    return ctx.json({ approval });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.get('/tool-events', async (ctx) => {
  try {
    const { workspace_id } = ctx.get('auth');
    const tool_events = await ctx.get('dal').listToolEvents(workspace_id, listOpts(ctx));
    return ctx.json({ tool_events });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.post('/tool-events', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'tool_event:report')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit tool-event reporting');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    const canaryError = ensureCanaryLifecycleWrite(ctx, auth, body, 'tool_event');
    if (canaryError) return canaryError;
    if (!TOOL_ACTIONS.has(body.action as ToolEventAction)) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid tool action');
    if (!TOOL_STATUSES.has(String(body.status))) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid tool-event status');
    const tool_event = await ctx.get('dal').createToolEvent(workspace_id, user_id, body as never, {
      // W1 spine unification — SEPARATE param (never body-carried: the body is client-controlled).
      emitSpineEvent: envFlagTrue((ctx.env as { SPINE_TOOL_EVENT_UNIFICATION_ENABLED?: string }).SPINE_TOOL_EVENT_UNIFICATION_ENABLED),
      lineage: { ...lineageFor(auth as never), request_id: (ctx.get('request_id') as string | undefined) ?? null },
    });
    ctx.status(201);
    return ctx.json({ tool_event });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.get('/metric-deltas', async (ctx) => {
  try {
    const { workspace_id } = ctx.get('auth');
    const metric_deltas = await ctx.get('dal').listMetricDeltas(workspace_id, listOpts(ctx));
    return ctx.json({ metric_deltas });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.post('/metric-deltas', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'metric_delta:record')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit metric-delta recording');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    const canaryError = ensureCanaryLifecycleWrite(ctx, auth, body, 'metric_delta');
    if (canaryError) return canaryError;
    if (typeof body.metric_id !== 'string' || !body.metric_id.trim()) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'metric_id is required');
    }
    const metric_delta = await ctx.get('dal').createMetricDelta(workspace_id, user_id, body as never);
    ctx.status(201);
    return ctx.json({ metric_delta });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.post('/customer-data/export-requests', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (isCanaryLifecycle(auth)) return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle token cannot request customer data export');
    const { workspace_id, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'customer_data:export')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit customer export requests');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    const approval = await ctx.get('dal').createApprovalRequest(workspace_id, user_id, {
      packet_id: typeof body.target_packet_id === 'string' ? body.target_packet_id : null,
      reason: lifecycleReason('export', body),
    });
    ctx.status(201);
    return ctx.json({
      request: {
        request_kind: 'export',
        status: 'approval_requested',
        approval,
        export_mode: 'metadata_redacted_only',
        blocked_surfaces: [
          'raw_graph',
          'full_tenant_memory',
          'xlooop_internal_templates',
          'governance_scoring',
          'agent_routing',
          'private_graph_schema',
          'secrets',
          'search_all_memory',
        ],
      },
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

operationalSpineRoute.post('/customer-data/delete-requests', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (isCanaryLifecycle(auth)) return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle token cannot request customer data deletion');
    const { workspace_id, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'customer_data:delete')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit customer delete requests');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    if (typeof body.target_packet_id !== 'string' || !body.target_packet_id.trim()) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'target_packet_id is required for delete requests');
    }
    const approval = await ctx.get('dal').createApprovalRequest(workspace_id, user_id, {
      packet_id: body.target_packet_id,
      reason: lifecycleReason('delete', body),
    });
    ctx.status(201);
    return ctx.json({
      request: {
        request_kind: 'delete',
        status: 'approval_requested',
        approval,
        deletion_mode: 'approved_packet_archive_with_audit_receipt',
      },
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

async function executeLifecycle(ctx: any, kind: 'export' | 'delete') {
  try {
    const auth = ctx.get('auth');
    if (isCanaryLifecycle(auth)) return jsonError(ctx, 403, 'FORBIDDEN', 'canary lifecycle token cannot execute customer data lifecycle actions');
    const { workspace_id, user_id } = auth;
    if (!(await authorizeSpineWrite(ctx, 'customer_data:execute')).allowed) return jsonError(ctx, 403, 'FORBIDDEN', 'role does not permit customer lifecycle execution');
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    if (kind === 'delete' && (typeof body.target_packet_id !== 'string' || !body.target_packet_id.trim())) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'target_packet_id is required for delete execution');
    }
    const execution = await ctx.get('dal').executeCustomerDataLifecycleRequest(workspace_id, user_id, {
      approval_id: ctx.req.param('approval_id'),
      request_kind: kind,
      target_packet_id: typeof body.target_packet_id === 'string' ? body.target_packet_id : null,
      execution_note: typeof body.execution_note === 'string' ? body.execution_note : null,
    });
    return ctx.json({ execution });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
}

operationalSpineRoute.post('/customer-data/export-requests/:approval_id/execute', (ctx) => executeLifecycle(ctx, 'export'));
operationalSpineRoute.post('/customer-data/delete-requests/:approval_id/execute', (ctx) => executeLifecycle(ctx, 'delete'));
