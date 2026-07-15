import { assertWorkspaceScope } from './DalAdapter';
import { makeError, randomNanoid } from './shared-helpers';
import { withWorkspaceRlsContext } from './operational-spine-store';
import type { Sql } from '../db/client';
import type {
  GovernedExecutionReceipt,
  GovernedClosingAttestationInput,
  IntakeExecutionResult,
  IntakeResolution,
  IntakeResolutionInput,
  UserId,
  WorkspaceId,
} from './types';

type ResolutionRow = Omit<IntakeResolution, 'target' | 'authority' | 'context_summary' | 'prior_work' | 'freshness' | 'action_payload'> & {
  target: unknown;
  authority: unknown;
  context_summary: unknown;
  prior_work: unknown;
  freshness: unknown;
  action_payload: unknown;
};

function objectValue<T extends object>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
    } catch { /* malformed stored JSON resolves conservatively */ }
  }
  return fallback;
}

function normalizeResolution(row: ResolutionRow): IntakeResolution {
  return {
    ...row,
    confidence: Number(row.confidence),
    ambiguity: row.ambiguity === true,
    target: objectValue(row.target, { type: 'none', id: null, label: 'Unavailable target' }),
    authority: objectValue(row.authority, { allowed: false, safe_reason: 'authority unavailable' }),
    context_summary: objectValue(row.context_summary, { reference_count: 0, source_count: 0, evidence_count: 0 }),
    prior_work: objectValue(row.prior_work, { discovery_executed: true, active_work_count: 0, pending_approval_count: 0, digest_sha256: '' }),
    freshness: objectValue(row.freshness, { generated_at: row.created_at, expires_at: row.expires_at }),
    action_payload: objectValue(row.action_payload, {}),
    required_tools: Array.isArray(row.required_tools) ? row.required_tools : [],
    current_work_version: Number(row.current_work_version || 0),
    version: Number(row.version || 1),
  };
}

export async function createIntakeResolutionRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: IntakeResolutionInput,
): Promise<IntakeResolution> {
  assertWorkspaceScope(workspaceId);
  const id = `inr_${randomNanoid()}`;
  const [rows] = await withWorkspaceRlsContext<[ResolutionRow[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      INSERT INTO intake_resolutions (
        id, workspace_id, actor_user_id, project_id, client_request_id, request_digest,
        operation, confidence, ambiguity, target, effect_summary, risk, authority,
        context_summary, prior_work, governance_summary, role_label, approach_label, grounding_summary,
        guardrails, freshness, required_tools, requires_confirmation, next_step, action_payload,
        current_work_version, expires_at
      ) VALUES (
        ${id}, ${workspaceId}, ${actorUserId}, ${input.project_id ?? null}, ${input.client_request_id}, ${input.request_digest},
        ${input.operation}, ${input.confidence}, ${input.ambiguity}, ${JSON.stringify(input.target)}::jsonb,
        ${input.effect_summary}, ${input.risk}, ${JSON.stringify(input.authority)}::jsonb,
        ${JSON.stringify(input.context_summary)}::jsonb, ${JSON.stringify(input.prior_work ?? { discovery_executed: true, active_work_count: 0, pending_approval_count: 0, digest_sha256: '' })}::jsonb,
        ${input.governance_summary ?? 'Governance summary unavailable'}, ${input.role_label ?? 'Workspace member'},
        ${input.approach_label ?? 'Governed operation'}, ${input.grounding_summary ?? 'No grounding summary'},
        ${input.guardrails ?? []}, ${JSON.stringify(input.freshness ?? { generated_at: new Date().toISOString(), expires_at: input.expires_at })}::jsonb,
        ${(input.required_tools ?? []) as unknown as string[]},
        ${input.requires_confirmation}, ${input.next_step}, ${JSON.stringify(input.action_payload ?? {})}::jsonb,
        ${input.current_work_version ?? 0}, ${input.expires_at}
      )
      ON CONFLICT (workspace_id, actor_user_id, client_request_id) DO UPDATE
        SET client_request_id = EXCLUDED.client_request_id
        WHERE intake_resolutions.request_digest = EXCLUDED.request_digest
      RETURNING *
    `,
  ]);
  if (!rows[0]) throw makeError('CONFLICT', 'client_request_id was already used for different input', 409);
  return normalizeResolution(rows[0]);
}

export async function countGovernedExecutionReceiptsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
): Promise<number> {
  assertWorkspaceScope(workspaceId);
  const [rows] = await withWorkspaceRlsContext<[Array<{ receipt_count: number | string }>]>(
    sql,
    workspaceId,
    (tx) => [tx/*sql*/`
      SELECT count(*)::integer AS receipt_count
        FROM governed_execution_receipts
       WHERE workspace_id = ${workspaceId}
    `],
    { readOnly: true },
  );
  return Number(rows[0]?.receipt_count ?? 0);
}

type ExecutionRow = ResolutionRow & {
  receipt_id: string;
  receipt_client_request_id: string;
  receipt_target_type: GovernedExecutionReceipt['target_type'];
  receipt_target_id: string | null;
  receipt_created_at: string;
  receipt_closing_attestation_id: string;
};

export async function executeIntakeResolutionRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  resolutionId: string,
  expectedVersion: number,
  expectedCurrentWorkVersion: number,
  clientRequestId: string,
  closing: GovernedClosingAttestationInput,
): Promise<IntakeExecutionResult> {
  assertWorkspaceScope(workspaceId);
  const packetId = `pkt_${randomNanoid()}`;
  const receiptId = `ger_${randomNanoid()}`;
  const outboxId = `out_${randomNanoid()}`;
  const closingAttestationId = `cla_${randomNanoid()}`;
  const [rows] = await withWorkspaceRlsContext<[ExecutionRow[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      WITH claimed AS (
        UPDATE intake_resolutions
           SET status = 'consumed', consumed_at = now()
         WHERE id = ${resolutionId}
           AND workspace_id = ${workspaceId}
           AND actor_user_id = ${actorUserId}
           AND status = 'pending'
           AND version = ${expectedVersion}
           AND current_work_version = ${expectedCurrentWorkVersion}
           AND current_work_version = COALESCE((SELECT max(version) FROM task_packets WHERE workspace_id = ${workspaceId} AND lifecycle_state <> 'archived'), 0)
           AND expires_at > now()
           AND requires_confirmation = true
           AND (authority->>'allowed')::boolean = true
           AND operation IN ('create_work','continue_work','decide')
           AND (
             (operation = 'create_work' AND (
               NULLIF(action_payload->>'project_id','') IS NULL
               OR EXISTS (
                 SELECT 1 FROM projects p
                  WHERE p.id = action_payload->>'project_id'
                    AND p.workspace_id = intake_resolutions.workspace_id
                    AND p.status <> 'archived'
               )
             ))
             OR (operation = 'continue_work' AND EXISTS (
               SELECT 1 FROM task_packets p
                WHERE p.workspace_id = intake_resolutions.workspace_id
                  AND p.id = intake_resolutions.action_payload->>'packet_id'
                  AND p.version = (intake_resolutions.action_payload->>'packet_version')::integer
                  AND p.lifecycle_state IN ('draft','ready','in_progress','evidence_ready','approval_requested')
             ))
             OR (operation = 'decide' AND EXISTS (
               SELECT 1 FROM approval_requests a
                WHERE a.workspace_id = intake_resolutions.workspace_id
                  AND a.id = intake_resolutions.action_payload->>'approval_id'
                  AND a.status = 'requested'
                  AND (a.packet_id IS NULL OR a.packet_version = (
                    SELECT version FROM task_packets WHERE id = a.packet_id AND workspace_id = a.workspace_id
                  ))
             ))
           )
        RETURNING *
      ), new_packet AS (
        INSERT INTO task_packets (
          id, workspace_id, project_id, title, summary, lifecycle_state, actor_user_id,
          allowed_tools, forbidden_tools, source_refs, approval_required
        )
        SELECT ${packetId}, workspace_id, NULLIF(action_payload->>'project_id',''),
          left(action_payload->>'title', 160), left(action_payload->>'summary', 2000),
          'draft', actor_user_id, required_tools, '{}', '{}', true
          FROM claimed WHERE operation = 'create_work'
        RETURNING id
      ), continued AS (
        UPDATE task_packets p
           SET lifecycle_state = 'in_progress', version = p.version + 1, updated_at = now()
          FROM claimed c
         WHERE c.operation = 'continue_work'
           AND p.workspace_id = c.workspace_id
           AND p.id = c.action_payload->>'packet_id'
           AND p.version = (c.action_payload->>'packet_version')::integer
           AND p.lifecycle_state IN ('draft','ready','in_progress','evidence_ready','approval_requested')
        RETURNING p.id
      ), decided AS (
        UPDATE approval_requests a
           SET status = c.action_payload->>'decision', decided_by = c.actor_user_id, decided_at = now()
          FROM claimed c
         WHERE c.operation = 'decide'
           AND a.workspace_id = c.workspace_id
           AND a.id = c.action_payload->>'approval_id'
           AND a.status = 'requested'
           AND (a.packet_id IS NULL OR a.packet_version = (SELECT version FROM task_packets WHERE id = a.packet_id AND workspace_id = a.workspace_id))
        RETURNING a.id
      ), effect AS (
        SELECT c.id AS resolution_id, c.workspace_id, c.actor_user_id, c.operation,
          CASE WHEN c.operation = 'decide' THEN 'approval' ELSE 'task_packet' END AS target_type,
          COALESCE((SELECT id FROM new_packet), (SELECT id FROM continued), (SELECT id FROM decided)) AS target_id,
          c.effect_summary
        FROM claimed c
      ), receipt AS (
        INSERT INTO governed_execution_receipts (
          id, workspace_id, resolution_id, actor_user_id, client_request_id,
          operation, target_type, target_id, result, effect_summary, closing_attestation_id
        )
        SELECT ${receiptId}, workspace_id, resolution_id, actor_user_id, ${clientRequestId},
          operation, target_type, target_id, 'completed', effect_summary, ${closingAttestationId}
          FROM effect WHERE target_id IS NOT NULL
        RETURNING *
      ), closed AS (
        INSERT INTO closing_attestations (
          id, workspace_id, principal_id, correlation_id, role_key, closing_skill, outcome,
          evidence_ref_ids, content_sha256, signature_alg, signature
        )
        SELECT ${closingAttestationId}, workspace_id, actor_user_id, resolution_id, ${closing.role_key},
          ${closing.closing_skill}, ${closing.outcome}, ${closing.evidence_ref_ids}, ${closing.content_sha256},
          ${closing.signature_alg}, ${closing.signature}
          FROM receipt
        RETURNING id
      ), queued AS (
        INSERT INTO projection_outbox (id, workspace_id, event_type, aggregate_type, aggregate_id, payload)
        SELECT ${outboxId}, workspace_id, 'governed_intake.executed', target_type, target_id,
          jsonb_build_object('resolution_id', resolution_id, 'receipt_id', id, 'operation', operation)
          FROM receipt
        RETURNING id
      )
      SELECT c.*, r.id AS receipt_id, r.client_request_id AS receipt_client_request_id, r.target_type AS receipt_target_type,
        r.target_id AS receipt_target_id, r.created_at AS receipt_created_at,
        r.closing_attestation_id AS receipt_closing_attestation_id
      FROM claimed c JOIN receipt r ON r.resolution_id = c.id JOIN closed x ON x.id = r.closing_attestation_id
    `,
  ]);
  const row = rows[0];
  if (row) {
    const resolution = normalizeResolution(row);
    const receipt: GovernedExecutionReceipt = {
      id: row.receipt_id,
      workspace_id: row.workspace_id,
      resolution_id: row.id,
      actor_user_id: row.actor_user_id,
      client_request_id: row.receipt_client_request_id,
      operation: row.operation,
      target_type: row.receipt_target_type,
      target_id: row.receipt_target_id,
      result: 'completed',
      effect_summary: row.effect_summary,
      closing_attestation_id: row.receipt_closing_attestation_id,
      created_at: row.receipt_created_at,
    };
    return {
      ok: true,
      resolution,
      receipt,
      ...(row.receipt_target_type === 'task_packet' && row.receipt_target_id ? { packet_id: row.receipt_target_id } : {}),
    };
  }

  const [replayRows] = await withWorkspaceRlsContext<[ExecutionRow[]]>(sql, workspaceId, (tx) => [tx/*sql*/`
    SELECT c.*, r.id AS receipt_id, r.client_request_id AS receipt_client_request_id,
      r.target_type AS receipt_target_type, r.target_id AS receipt_target_id, r.created_at AS receipt_created_at,
      r.closing_attestation_id AS receipt_closing_attestation_id
      FROM intake_resolutions c
      JOIN governed_execution_receipts r ON r.resolution_id = c.id
     WHERE c.id = ${resolutionId}
       AND c.workspace_id = ${workspaceId}
       AND c.actor_user_id = ${actorUserId}
     LIMIT 1
  `], { readOnly: true });
  const replay = replayRows[0];
  if (replay) {
    if (replay.receipt_client_request_id !== clientRequestId) return { ok: false, reason: 'already_consumed' };
    if (Number(replay.version) !== expectedVersion || Number(replay.current_work_version) !== expectedCurrentWorkVersion) {
      return { ok: false, reason: 'stale' };
    }
    const resolution = normalizeResolution(replay);
    const receipt: GovernedExecutionReceipt = {
      id: replay.receipt_id,
      workspace_id: replay.workspace_id,
      resolution_id: replay.id,
      actor_user_id: replay.actor_user_id,
      client_request_id: replay.receipt_client_request_id,
      operation: replay.operation,
      target_type: replay.receipt_target_type,
      target_id: replay.receipt_target_id,
      result: 'completed',
      effect_summary: replay.effect_summary,
      closing_attestation_id: replay.receipt_closing_attestation_id,
      created_at: replay.receipt_created_at,
    };
    return {
      ok: true,
      replayed: true,
      resolution,
      receipt,
      ...(replay.receipt_target_type === 'task_packet' && replay.receipt_target_id ? { packet_id: replay.receipt_target_id } : {}),
    };
  }

  const [stateRows] = await withWorkspaceRlsContext<[Array<Pick<IntakeResolution, 'status' | 'expires_at' | 'version' | 'current_work_version'>>]>(
    sql, workspaceId, (tx) => [tx/*sql*/`
      SELECT status, expires_at, version, current_work_version FROM intake_resolutions
       WHERE id = ${resolutionId} AND workspace_id = ${workspaceId} AND actor_user_id = ${actorUserId} LIMIT 1
    `], { readOnly: true },
  );
  const state = stateRows[0];
  if (!state) return { ok: false, reason: 'not_found' };
  if (state.status === 'consumed') return { ok: false, reason: 'already_consumed' };
  if (new Date(state.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (Number(state.version) !== expectedVersion || Number(state.current_work_version) !== expectedCurrentWorkVersion) return { ok: false, reason: 'stale' };
  return { ok: false, reason: 'unsupported' };
}
