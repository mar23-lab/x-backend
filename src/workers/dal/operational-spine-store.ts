// operational-spine-store.ts · tenant-scoped task packets, evidence, approvals, tool events.
//
// This is the product/backend operational projection. It never exposes MB-P raw
// governance graph, operator memory, scoring templates, private schemas, or secrets.

import { assertWorkspaceScope } from './DalAdapter';
import { makeError, randomNanoid } from './shared-helpers';
import type { Sql } from '../db/client';
import type {
  WorkspaceId,
  UserId,
  TaskPacket,
  TaskPacketInput,
  EvidenceItem,
  EvidenceItemInput,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalDecisionInput,
  ToolEvent,
  ToolEventInput,
  MetricDelta,
  MetricDeltaInput,
  CustomerDataLifecycleExecution,
  CustomerDataLifecycleExecutionInput,
  OperationalSpineListOpts,
  TaskPacketCompletionEvaluation,
} from './types';
import { evaluateCompletion } from '../lib/completion-contract';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type TransactionSql = (strings: TemplateStringsArray, ...params: unknown[]) => unknown;
type TransactionCapableSql = {
  transaction: (
    queriesOrFn: (tx: TransactionSql) => unknown[],
    opts?: { isolationLevel?: 'ReadCommitted'; readOnly?: boolean },
  ) => Promise<unknown[]>;
};

// ⚠ NESTING GUARD (047-B audit): the @neondatabase/serverless driver does NOT support nested
// `.transaction()` calls. NEVER call withWorkspaceRlsContext (or any fn that uses it, e.g.
// getProjectRow) from INSIDE another withWorkspaceRlsContext callback — sequential calls are fine,
// nesting is not. Audit callers before wrapping a shared helper.
export async function withWorkspaceRlsContext<T extends unknown[]>(
  sql: Sql,
  workspaceId: WorkspaceId,
  queries: (tx: Sql) => unknown[],
  opts: { readOnly?: boolean } = {},
): Promise<T> {
  assertWorkspaceScope(workspaceId);
  const results = await (sql as unknown as TransactionCapableSql).transaction(
    (tx) => [
      tx/*sql*/`SELECT set_config('xlooop.current_workspace_id', ${workspaceId}, true) AS workspace_context`,
      ...queries(tx as unknown as Sql),
    ],
    { isolationLevel: 'ReadCommitted', readOnly: opts.readOnly },
  );
  return results.slice(1) as T;
}

function limitFor(raw?: number): number {
  return Math.max(1, Math.min(raw || DEFAULT_LIMIT, MAX_LIMIT));
}

function arrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function requireShortText(name: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw makeError('VALIDATION_ERROR', `${name} must be a non-empty string <= ${max} chars`, 400);
  }
  return value.trim();
}

async function assertPacketInWorkspace(sql: Sql, workspaceId: WorkspaceId, packetId: string | null | undefined): Promise<void> {
  if (!packetId) return;
  const [rows] = await withWorkspaceRlsContext<[Array<{ id: string }>]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT id FROM task_packets WHERE id = ${packetId} AND workspace_id = ${workspaceId} LIMIT 1
    `,
  ], { readOnly: true });
  if (!rows.length) {
    throw makeError('NOT_FOUND', 'packet_id does not exist in this workspace', 404);
  }
}

async function assertEventInWorkspace(sql: Sql, workspaceId: WorkspaceId, eventId: string | null | undefined): Promise<void> {
  if (!eventId) return;
  const [rows] = await withWorkspaceRlsContext<[Array<{ id: string }>]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT id FROM operation_events WHERE id = ${eventId} AND workspace_id = ${workspaceId} LIMIT 1
    `,
  ], { readOnly: true });
  if (!rows.length) {
    throw makeError('NOT_FOUND', 'event_id does not exist in this workspace', 404);
  }
}

async function assertEvidenceInWorkspace(sql: Sql, workspaceId: WorkspaceId, evidenceId: string | null | undefined): Promise<void> {
  if (!evidenceId) return;
  const [rows] = await withWorkspaceRlsContext<[Array<{ id: string }>]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT id FROM evidence_items WHERE id = ${evidenceId} AND workspace_id = ${workspaceId} LIMIT 1
    `,
  ], { readOnly: true });
  if (!rows.length) {
    throw makeError('NOT_FOUND', 'evidence_item_id does not exist in this workspace', 404);
  }
}

function normalizePacket(row: TaskPacket): TaskPacket {
  return {
    ...row,
    project_id: row.project_id ?? null,
    event_id: row.event_id ?? null,
    allowed_tools: arrayOrEmpty(row.allowed_tools),
    forbidden_tools: arrayOrEmpty(row.forbidden_tools),
    source_refs: arrayOrEmpty(row.source_refs),
    evidence_ref_ids: arrayOrEmpty(row.evidence_ref_ids),
    version: Number(row.version || 1),
    requested_output: row.requested_output ?? null,
    acceptance_criteria: arrayOrEmpty(row.acceptance_criteria),
    acceptance_status: row.acceptance_status ?? 'not_required',
    evidence_required: row.evidence_required !== false,
    execution_status: row.execution_status ?? 'pending',
    blockers_accepted: row.blockers_accepted === true,
    receipt_required: row.receipt_required !== false,
    plan_projection_required: row.plan_projection_required !== false,
    plan_projection_updated_at: row.plan_projection_updated_at ?? null,
    completed_at: row.completed_at ?? null,
    expires_at: row.expires_at ?? null,
  };
}

export async function createTaskPacketRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: TaskPacketInput,
): Promise<TaskPacket> {
  assertWorkspaceScope(workspaceId);
  const id = input.id?.trim() || `pkt_${randomNanoid()}`;
  const title = requireShortText('title', input.title, 160);
  const summary = requireShortText('summary', input.summary, 2000);
  await assertEventInWorkspace(sql, workspaceId, input.event_id);

  const allowed = arrayOrEmpty(input.allowed_tools);
  const forbidden = arrayOrEmpty(input.forbidden_tools);
  const sources = arrayOrEmpty(input.source_refs);
  const [rows] = await withWorkspaceRlsContext<[TaskPacket[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      INSERT INTO task_packets (
        id, workspace_id, project_id, event_id, title, summary, lifecycle_state,
        actor_user_id, allowed_tools, forbidden_tools, source_refs,
        approval_required, expires_at
      ) VALUES (
        ${id}, ${workspaceId}, ${input.project_id ?? null}, ${input.event_id ?? null},
        ${title}, ${summary}, ${input.lifecycle_state ?? 'draft'}, ${actorUserId},
        ${allowed as unknown as string[]}, ${forbidden as unknown as string[]},
        ${sources as unknown as string[]}, ${input.approval_required !== false},
        ${input.expires_at ?? null}
      )
      RETURNING id, workspace_id, project_id, event_id, title, summary, lifecycle_state,
        actor_user_id, allowed_tools, forbidden_tools, source_refs, evidence_ref_ids,
        approval_required, version, requested_output, acceptance_criteria, acceptance_status,
        evidence_required, execution_status, blockers_accepted, receipt_required,
        plan_projection_required, plan_projection_updated_at, completed_at,
        expires_at, created_at, updated_at
    `,
  ]);
  return normalizePacket(rows[0]!);
}

export async function listTaskPacketsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  opts: OperationalSpineListOpts = {},
): Promise<TaskPacket[]> {
  assertWorkspaceScope(workspaceId);
  const limit = limitFor(opts.limit);
  const [rows] = await withWorkspaceRlsContext<[TaskPacket[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT id, workspace_id, project_id, event_id, title, summary, lifecycle_state,
        actor_user_id, allowed_tools, forbidden_tools, source_refs, evidence_ref_ids,
        approval_required, version, requested_output, acceptance_criteria, acceptance_status,
        evidence_required, execution_status, blockers_accepted, receipt_required,
        plan_projection_required, plan_projection_updated_at, completed_at,
        expires_at, created_at, updated_at
      FROM task_packets
      WHERE workspace_id = ${workspaceId}
        AND (${opts.packet_id ?? null}::text IS NULL OR id = ${opts.packet_id ?? null})
        AND lifecycle_state <> 'archived'
      ORDER BY updated_at DESC, id DESC
      LIMIT ${limit}
    `,
  ], { readOnly: true });
  return rows.map(normalizePacket);
}

type CompletionFactsRow = {
  packet_id: string;
  packet_version: number;
  requested_output: string | null;
  acceptance_criteria: unknown;
  acceptance_status: string;
  evidence_required: boolean;
  execution_status: string;
  blockers_accepted: boolean;
  approval_required: boolean;
  receipt_required: boolean;
  plan_projection_required: boolean;
  plan_projection_updated_at: string | null;
  packet_updated_at: string;
  evidence_attached_count: number | string;
  receipt_count: number | string;
  open_blocker_count: number | string;
  approved_version: number | string | null;
};

/** Server-derived, counts-only completion facts. No client field can assert its own completion. */
export async function evaluateTaskPacketCompletionRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  packetId: string,
): Promise<TaskPacketCompletionEvaluation | null> {
  assertWorkspaceScope(workspaceId);
  if (!packetId.trim()) return null;
  const [rows] = await withWorkspaceRlsContext<[CompletionFactsRow[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT p.id AS packet_id,
             p.version AS packet_version,
             p.requested_output,
             p.acceptance_criteria,
             p.acceptance_status,
             p.evidence_required,
             p.execution_status,
             p.blockers_accepted,
             p.approval_required,
             p.receipt_required,
             p.plan_projection_required,
             p.plan_projection_updated_at,
             p.updated_at AS packet_updated_at,
             (SELECT count(*) FROM evidence_items e
               WHERE e.workspace_id = p.workspace_id AND e.packet_id = p.id) AS evidence_attached_count,
             (SELECT count(*) FROM evidence_items e
               WHERE e.workspace_id = p.workspace_id AND e.packet_id = p.id AND e.kind = 'receipt') AS receipt_count,
             (SELECT count(*) FROM operation_events oe
               WHERE oe.workspace_id = p.workspace_id AND oe.id = p.event_id AND oe.status = 'blocked') AS open_blocker_count,
             (SELECT max(ar.packet_version) FROM approval_requests ar
               WHERE ar.workspace_id = p.workspace_id AND ar.packet_id = p.id AND ar.status = 'approved') AS approved_version
        FROM task_packets p
       WHERE p.workspace_id = ${workspaceId} AND p.id = ${packetId}
       LIMIT 1
    `,
  ], { readOnly: true });
  const row = rows[0];
  if (!row) return null;
  const version = Number(row.packet_version);
  const evidenceCount = Number(row.evidence_attached_count);
  const receiptPresent = !row.receipt_required || Number(row.receipt_count) > 0;
  const approvedVersion = row.approved_version === null ? null : Number(row.approved_version);
  const acceptanceCriteria = arrayOrEmpty(row.acceptance_criteria);
  const planProjectionUpdated = !row.plan_projection_required || (
    row.plan_projection_updated_at !== null &&
    new Date(row.plan_projection_updated_at).getTime() >= new Date(row.packet_updated_at).getTime()
  );
  const verdict = evaluateCompletion({
    hasRequestedOutput: Boolean(row.requested_output?.trim()),
    acceptanceCriteriaRequired: acceptanceCriteria.length > 0,
    acceptanceCriteriaPass: row.acceptance_status === 'passed' || row.acceptance_status === 'not_required',
    evidenceRequired: row.evidence_required,
    evidenceAttachedCount: evidenceCount,
    executionFinished: row.execution_status === 'succeeded' || row.execution_status === 'not_required',
    openBlockerCount: Number(row.open_blocker_count),
    blockersExplicitlyAccepted: row.blockers_accepted,
    approvalRequired: row.approval_required,
    approvalPresent: approvedVersion !== null,
    approvedVersion,
    currentVersion: version,
    receiptPresent,
    planProjectionUpdated,
  });
  return {
    packet_id: row.packet_id,
    packet_version: version,
    can_complete: verdict.can_complete,
    unmet_reasons: verdict.unmet,
    facts: {
      evidence_attached_count: evidenceCount,
      open_blocker_count: Number(row.open_blocker_count),
      approval_required: row.approval_required,
      approval_present_for_current_version: approvedVersion === version,
      approved_version: approvedVersion,
      receipt_present: receiptPresent,
      plan_projection_updated: planProjectionUpdated,
    },
  };
}

export async function createEvidenceItemRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: EvidenceItemInput,
): Promise<EvidenceItem> {
  assertWorkspaceScope(workspaceId);
  const id = input.id?.trim() || `ev_${randomNanoid()}`;
  const title = requireShortText('title', input.title, 160);
  const uri = requireShortText('uri', input.uri, 1024);
  await assertPacketInWorkspace(sql, workspaceId, input.packet_id);
  await assertEventInWorkspace(sql, workspaceId, input.event_id);

  const queries = (tx: Sql) => {
    const stmts = [
      tx/*sql*/`
        INSERT INTO evidence_items (
          id, workspace_id, packet_id, event_id, kind, title, uri, content_hash,
          summary, redaction_status, actor_user_id
        ) VALUES (
          ${id}, ${workspaceId}, ${input.packet_id ?? null}, ${input.event_id ?? null},
          ${input.kind}, ${title}, ${uri}, ${input.content_hash ?? null},
          ${input.summary ?? null}, ${input.redaction_status ?? 'metadata_only'}, ${actorUserId}
        )
        RETURNING id, workspace_id, packet_id, event_id, kind, title, uri, content_hash,
          summary, redaction_status, actor_user_id, created_at
      `,
    ];
    if (input.packet_id) {
      stmts.push(tx/*sql*/`
        UPDATE task_packets
           SET evidence_ref_ids = array_append(evidence_ref_ids, ${id}),
               lifecycle_state = CASE
                 WHEN lifecycle_state IN ('draft', 'ready', 'in_progress') THEN 'evidence_ready'
                 ELSE lifecycle_state
               END,
               updated_at = now()
         WHERE id = ${input.packet_id} AND workspace_id = ${workspaceId}
      `);
    }
    return stmts;
  };
  const [rows] = await withWorkspaceRlsContext<[EvidenceItem[], unknown?]>(sql, workspaceId, queries);
  return rows[0]!;
}

export async function listEvidenceItemsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  opts: OperationalSpineListOpts = {},
): Promise<EvidenceItem[]> {
  assertWorkspaceScope(workspaceId);
  const [rows] = await withWorkspaceRlsContext<[EvidenceItem[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT id, workspace_id, packet_id, event_id, kind, title, uri, content_hash,
        summary, redaction_status, actor_user_id, created_at
      FROM evidence_items
      WHERE workspace_id = ${workspaceId}
        AND (${opts.packet_id ?? null}::text IS NULL OR packet_id = ${opts.packet_id ?? null})
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitFor(opts.limit)}
    `,
  ], { readOnly: true });
  return rows;
}

export async function createApprovalRequestRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: ApprovalRequestInput,
): Promise<ApprovalRequest> {
  assertWorkspaceScope(workspaceId);
  const id = input.id?.trim() || `apr_${randomNanoid()}`;
  const reason = requireShortText('reason', input.reason, 1000);
  await assertPacketInWorkspace(sql, workspaceId, input.packet_id);
  await assertEventInWorkspace(sql, workspaceId, input.event_id);
  const [rows] = await withWorkspaceRlsContext<[ApprovalRequest[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      INSERT INTO approval_requests (
        id, workspace_id, packet_id, packet_version, event_id, requested_by, status, reason
      ) VALUES (
        ${id}, ${workspaceId}, ${input.packet_id ?? null},
        (SELECT version FROM task_packets WHERE id = ${input.packet_id ?? null} AND workspace_id = ${workspaceId}),
        ${input.event_id ?? null},
        ${actorUserId}, 'requested', ${reason}
      )
      RETURNING id, workspace_id, packet_id, packet_version, event_id, requested_by, decided_by,
        status, reason, decision_comment, requested_at, decided_at
    `,
  ]);
  return rows[0]!;
}

export async function decideApprovalRequestRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  approvalId: string,
  actorUserId: UserId,
  input: ApprovalDecisionInput,
): Promise<ApprovalRequest | null> {
  assertWorkspaceScope(workspaceId);
  if (!approvalId) return null;
  const [rows] = await withWorkspaceRlsContext<[ApprovalRequest[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      UPDATE approval_requests
         SET status = ${input.status},
             decided_by = ${actorUserId},
             decision_comment = ${input.decision_comment ?? null},
             decided_at = now()
       WHERE id = ${approvalId}
         AND workspace_id = ${workspaceId}
         AND status = 'requested'
      RETURNING id, workspace_id, packet_id, packet_version, event_id, requested_by, decided_by,
        status, reason, decision_comment, requested_at, decided_at
    `,
  ]);
  return rows[0] ?? null;
}

export async function listApprovalRequestsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  opts: OperationalSpineListOpts = {},
): Promise<ApprovalRequest[]> {
  assertWorkspaceScope(workspaceId);
  const [rows] = await withWorkspaceRlsContext<[ApprovalRequest[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT id, workspace_id, packet_id, packet_version, event_id, requested_by, decided_by,
        status, reason, decision_comment, requested_at, decided_at
      FROM approval_requests
      WHERE workspace_id = ${workspaceId}
        AND (${opts.packet_id ?? null}::text IS NULL OR packet_id = ${opts.packet_id ?? null})
      ORDER BY requested_at DESC, id DESC
      LIMIT ${limitFor(opts.limit)}
    `,
  ], { readOnly: true });
  return rows;
}

/** W1 spine-unification options — a SEPARATE parameter, never part of ToolEventInput: the routes pass the
 *  request body straight into `input`, so anything living there would be client-injectable. The routes compute
 *  this from ctx.env (flag) + the verified auth (lineage). */
export interface SpineUnificationOpts {
  /** true only when SPINE_TOOL_EVENT_UNIFICATION_ENABLED is enabled (route-read via envFlagTrue). Off = byte-identical legacy. */
  emitSpineEvent?: boolean;
  /** 050 actor-lineage for the companion event (lineageFor(auth) at the route — server-derived, never body). */
  lineage?: {
    authorized_by_user_id: string | null;
    instrument_kind: string | null;
    authority_source: string | null;
    request_id: string | null;
  } | null;
}

/** Compile-checked companion source_tool — an invalid value is a TS error (the no-raw-insert gate's typed-seam
 *  property, preserved even though this store is allowlisted for the same-transaction INSERT). */
const TOOL_ACTION_SOURCE: import('./types/event').SourceTool = 'tool_action';

/** tool_events.status → operation_events.status for the companion spine event (both vocabularies frozen). */
function spineStatusForToolEvent(status: ToolEvent['status']): 'completed' | 'failed' {
  return status === 'failed' || status === 'denied' ? 'failed' : 'completed';
}

export async function createToolEventRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: ToolEventInput,
  opts: SpineUnificationOpts = {},
): Promise<ToolEvent> {
  assertWorkspaceScope(workspaceId);
  const id = input.id?.trim() || `te_${randomNanoid()}`;
  const summary = requireShortText('summary', input.summary, 512);
  await assertPacketInWorkspace(sql, workspaceId, input.packet_id);
  await assertEvidenceInWorkspace(sql, workspaceId, input.evidence_item_id);

  if (!opts.emitSpineEvent) {
    // Legacy path (flag off) — byte-identical to the pre-W1 behaviour: one INSERT, no spine event, no
    // event_id column touched (works pre-migration-057 too).
    const [rows] = await withWorkspaceRlsContext<[ToolEvent[]]>(sql, workspaceId, (tx) => [
      tx/*sql*/`
        INSERT INTO tool_events (
          id, workspace_id, packet_id, tool_name, action, actor_user_id,
          status, evidence_item_id, summary
        ) VALUES (
          ${id}, ${workspaceId}, ${input.packet_id ?? null}, ${input.tool_name},
          ${input.action}, ${actorUserId}, ${input.status}, ${input.evidence_item_id ?? null},
          ${summary}
        )
        RETURNING id, workspace_id, packet_id, tool_name, action, actor_user_id,
          status, evidence_item_id, summary, created_at
      `,
    ]);
    return rows[0]!;
  }

  // W1 · G2 spine unification (D1 companion-emission): the tool event AND its companion operation_events row
  // commit in the SAME RLS transaction — a tool action can never exist off the causal spine (and vice versa).
  // The companion carries source_tool='tool_action' (migration 057 CHECK; deliberately ABSENT from
  // VALID_SOURCE_TOOLS so it is never caller-suppliable via /events — the document_upload pattern) + the 050
  // actor-lineage from the verified route auth.
  const spineEventId = `ev_${randomNanoid()}`;
  const spineSummary = `[tool] ${input.tool_name}:${input.action} — ${summary}`.slice(0, 512);
  const lin = opts.lineage ?? null;
  const [rows] = await withWorkspaceRlsContext<[ToolEvent[], unknown]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      INSERT INTO tool_events (
        id, workspace_id, packet_id, tool_name, action, actor_user_id,
        status, evidence_item_id, summary, event_id
      ) VALUES (
        ${id}, ${workspaceId}, ${input.packet_id ?? null}, ${input.tool_name},
        ${input.action}, ${actorUserId}, ${input.status}, ${input.evidence_item_id ?? null},
        ${summary}, ${spineEventId}
      )
      RETURNING id, workspace_id, packet_id, tool_name, action, actor_user_id,
        status, evidence_item_id, summary, created_at, event_id
    `,
    tx/*sql*/`
      INSERT INTO operation_events (
        id, workspace_id, source_tool, status, summary, occurred_at, visibility,
        authorized_by_user_id, instrument_kind, authority_source, request_id, intent_id
      ) VALUES (
        ${spineEventId}, ${workspaceId}, ${TOOL_ACTION_SOURCE}, ${spineStatusForToolEvent(input.status)},
        ${spineSummary}, now(), 'internal_workspace',
        ${lin?.authorized_by_user_id ?? null}, ${lin?.instrument_kind ?? null},
        ${lin?.authority_source ?? null}, ${lin?.request_id ?? null},
        (SELECT oe.intent_id FROM task_packets tp
           JOIN operation_events oe ON oe.id = tp.event_id AND oe.workspace_id = tp.workspace_id
          WHERE tp.id = ${input.packet_id ?? null} AND tp.workspace_id = ${workspaceId})
      )
    `,
    // S3 - intent-spine binding (260718): the companion event inherits the task packet's intent,
    // derived SERVER-SIDE inside the same RLS transaction (task_packets.event_id ->
    // operation_events.intent_id; both workspace-scoped), never body-carried (packet_id is the only
    // client input and is workspace-asserted above). NULL packet / NULL event_id / intent-less event
    // all collapse to NULL -- byte-identical to the prior behaviour for them. Closes the seam where
    // agent tool actions wrote spine events but never joined the intent lineage spine (ADR-ABS-011).
  ]);
  return rows[0]!;
}

export async function listToolEventsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  opts: OperationalSpineListOpts = {},
): Promise<ToolEvent[]> {
  assertWorkspaceScope(workspaceId);
  const [rows] = await withWorkspaceRlsContext<[ToolEvent[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT id, workspace_id, packet_id, tool_name, action, actor_user_id,
        status, evidence_item_id, summary, created_at
      FROM tool_events
      WHERE workspace_id = ${workspaceId}
        AND (${opts.packet_id ?? null}::text IS NULL OR packet_id = ${opts.packet_id ?? null})
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitFor(opts.limit)}
    `,
  ], { readOnly: true });
  return rows;
}

export async function createMetricDeltaRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: MetricDeltaInput,
): Promise<MetricDelta> {
  assertWorkspaceScope(workspaceId);
  const id = input.id?.trim() || `md_${randomNanoid()}`;
  const metricId = requireShortText('metric_id', input.metric_id, 160);
  await assertPacketInWorkspace(sql, workspaceId, input.packet_id);
  await assertEvidenceInWorkspace(sql, workspaceId, input.evidence_item_id);
  const before = input.before_value ?? null;
  const after = input.after_value ?? null;
  const delta = typeof before === 'number' && typeof after === 'number' ? after - before : null;
  const [rows] = await withWorkspaceRlsContext<[MetricDelta[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      INSERT INTO metric_deltas (
        id, workspace_id, packet_id, metric_id, before_value, after_value,
        delta_value, evidence_item_id, recorded_by
      ) VALUES (
        ${id}, ${workspaceId}, ${input.packet_id ?? null}, ${metricId},
        ${before}, ${after}, ${delta}, ${input.evidence_item_id ?? null}, ${actorUserId}
      )
      RETURNING id, workspace_id, packet_id, metric_id, before_value, after_value,
        delta_value, evidence_item_id, recorded_by, recorded_at
    `,
  ]);
  return rows[0]!;
}

export async function listMetricDeltasRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  opts: OperationalSpineListOpts = {},
): Promise<MetricDelta[]> {
  assertWorkspaceScope(workspaceId);
  const [rows] = await withWorkspaceRlsContext<[MetricDelta[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT id, workspace_id, packet_id, metric_id, before_value, after_value,
        delta_value, evidence_item_id, recorded_by, recorded_at
      FROM metric_deltas
      WHERE workspace_id = ${workspaceId}
        AND (${opts.packet_id ?? null}::text IS NULL OR packet_id = ${opts.packet_id ?? null})
      ORDER BY recorded_at DESC, id DESC
      LIMIT ${limitFor(opts.limit)}
    `,
  ], { readOnly: true });
  return rows;
}

export async function executeCustomerDataLifecycleRequestRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: CustomerDataLifecycleExecutionInput,
): Promise<CustomerDataLifecycleExecution> {
  assertWorkspaceScope(workspaceId);
  const approvalId = requireShortText('approval_id', input.approval_id, 160);
  const requestKind = input.request_kind;
  if (requestKind !== 'export' && requestKind !== 'delete') {
    throw makeError('VALIDATION_ERROR', 'request_kind must be export or delete', 400);
  }
  if (requestKind === 'delete' && !input.target_packet_id) {
    throw makeError('VALIDATION_ERROR', 'target_packet_id is required for delete execution', 400);
  }
  await assertPacketInWorkspace(sql, workspaceId, input.target_packet_id);

  const receiptId = `ev_${randomNanoid()}`;
  const toolEventId = `te_${randomNanoid()}`;
  const targetPacketId = input.target_packet_id ?? null;
  const receiptTitle = requestKind === 'delete'
    ? 'Customer data delete execution receipt'
    : 'Customer data export execution receipt';
  const receiptUri = `xlooop://customer-data/${requestKind}-receipts/${approvalId}`;
  const receiptSummary = [
    `${requestKind} execution completed through the backend operational spine.`,
    'Output is metadata/redacted only; raw graph, full tenant memory, platform internals, and secrets are excluded.',
    input.execution_note ? `Operator note: ${input.execution_note}` : '',
  ].filter(Boolean).join(' ');

  const queries = (tx: Sql) => {
    const stmts: unknown[] = [
      tx/*sql*/`
        SELECT id
          FROM approval_requests
         WHERE id = ${approvalId}
           AND workspace_id = ${workspaceId}
           AND status = 'approved'
         LIMIT 1
      `,
    ];
    if (requestKind === 'delete') {
      stmts.push(tx/*sql*/`
        UPDATE task_packets
           SET lifecycle_state = 'archived',
               updated_at = now()
         WHERE id = ${targetPacketId}
           AND workspace_id = ${workspaceId}
        RETURNING id
      `);
    } else {
      stmts.push(tx/*sql*/`
        SELECT ${targetPacketId}::text AS id
      `);
    }
    stmts.push(
      tx/*sql*/`
        INSERT INTO evidence_items (
          id, workspace_id, packet_id, event_id, kind, title, uri, content_hash,
          summary, redaction_status, actor_user_id
        ) VALUES (
          ${receiptId}, ${workspaceId}, ${targetPacketId}, null, 'receipt',
          ${receiptTitle}, ${receiptUri}, null, ${receiptSummary}, 'metadata_only',
          ${actorUserId}
        )
        RETURNING id, workspace_id, packet_id, event_id, kind, title, uri, content_hash,
          summary, redaction_status, actor_user_id, created_at
      `,
      tx/*sql*/`
        INSERT INTO tool_events (
          id, workspace_id, packet_id, tool_name, action, actor_user_id,
          status, evidence_item_id, summary
        ) VALUES (
          ${toolEventId}, ${workspaceId}, ${targetPacketId}, 'xlooop.customer_data_lifecycle',
          'report_tool_event', ${actorUserId}, 'completed', ${receiptId},
          ${requestKind === 'delete' ? 'approved customer delete/archive execution completed' : 'approved customer metadata export execution completed'}
        )
        RETURNING id, workspace_id, packet_id, tool_name, action, actor_user_id,
          status, evidence_item_id, summary, created_at
      `,
    );
    return stmts;
  };

  const [approvalRows, affectedRows, evidenceRows, toolEventRows] = await withWorkspaceRlsContext<[
    Array<{ id: string }>,
    Array<{ id: string | null }>,
    EvidenceItem[],
    ToolEvent[],
  ]>(sql, workspaceId, queries);

  if (!approvalRows.length) {
    throw makeError('NOT_FOUND', 'approved lifecycle approval request not found', 404);
  }
  const archivedPacketIds = requestKind === 'delete'
    ? affectedRows.map((row) => String(row.id)).filter(Boolean)
    : [];
  if (requestKind === 'delete' && archivedPacketIds.length === 0) {
    throw makeError('NOT_FOUND', 'target packet not found or already unavailable for deletion', 404);
  }

  return {
    request_kind: requestKind,
    status: 'executed',
    approval_id: approvalId,
    target_packet_id: targetPacketId,
    archived_packet_ids: archivedPacketIds,
    evidence_item: evidenceRows[0]!,
    tool_event: toolEventRows[0]!,
  };
}
