// plan-command-store.ts · authority-grade create/update/delete for customer plan entities.
//
// Each command uses one Neon transaction for the strict replay claim, canonical mutation, sibling
// re-pack, event, audit, outbox, and stored response. A retry returns the first durable result.

import type { Sql, SqlTx } from '../db/client';
import type {
  PlanEntityAuthorityReceipt,
  PlanEntityId,
  PlanEntityMutationIdempotencyInput,
  PlanEntityMutationOperation,
  UserId,
  WorkspaceId,
} from './types';
import { makeError } from './shared-helpers';

export interface PlanEntityCommandTarget {
  id: PlanEntityId;
  workspace_id: WorkspaceId;
  scope_id: string | null;
  scope_type: string | null;
  parent_id: PlanEntityId | null;
  position: number;
  updated_at: string;
}

export interface PlanEntityCommandSpec {
  operation: PlanEntityMutationOperation;
  entityId: PlanEntityId;
  workspaceId: WorkspaceId;
  actorUserId: UserId;
  idempotency: PlanEntityMutationIdempotencyInput;
  commandTimestamp: string;
  eventId: string;
  outboxId: string;
  mutation: unknown;
  lock: unknown;
  repackShift?: unknown;
  repackFinish?: unknown;
}

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

export function validatePlanIdempotency(input: PlanEntityMutationIdempotencyInput, route: string): void {
  if (!clean(input.key) || clean(input.key).length > 200) {
    throw makeError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required (1-200 chars)', 428);
  }
  if (!/^[a-f0-9]{64}$/.test(input.request_sha256)) {
    throw makeError('VALIDATION_ERROR', 'request_sha256 must be a lower-case SHA-256 value', 400);
  }
  if (input.route !== route) {
    throw makeError('VALIDATION_ERROR', 'strict plan route identity is invalid', 400);
  }
}

function receiptFromBody(body: unknown, replayed: boolean): PlanEntityAuthorityReceipt {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw makeError('PLAN_ATOMICITY_FAILED', 'strict plan replay body is unavailable', 500);
  }
  const row = body as Partial<PlanEntityAuthorityReceipt>;
  if (
    !row.plan_entity_id || !row.plan_revision_id || !row.operation || !row.receipt_id
    || !row.operation_event_id || !row.audit_event_id || !row.projection_outbox_id
    || !row.read_model_watermark
  ) {
    throw makeError('PLAN_ATOMICITY_FAILED', 'strict plan replay body is incomplete', 500);
  }
  return { ...row, replayed } as PlanEntityAuthorityReceipt;
}

export function planRouteIdentity(operation: PlanEntityMutationOperation, entityId?: string): string {
  if (operation === 'create') return 'POST /api/v1/plan/entity';
  return `${operation === 'update' ? 'PATCH' : 'DELETE'} /api/v1/plan/entity/${entityId}`;
}

function eventSummary(operation: PlanEntityMutationOperation): string {
  if (operation === 'create') return 'Plan entity created';
  if (operation === 'update') return 'Plan entity updated';
  return 'Plan entity deleted';
}

export async function executePlanEntityCommand(sql: Sql, spec: PlanEntityCommandSpec): Promise<PlanEntityAuthorityReceipt> {
  const { operation, entityId, workspaceId, actorUserId, idempotency } = spec;
  const claim = sql/*sql*/`
    INSERT INTO idempotency_keys (
      workspace_id, idempotency_key, route, actor_user_id, request_sha256, mode,
      response_status, response_body, completed_at
    ) VALUES (
      ${workspaceId}, ${idempotency.key}, ${idempotency.route}, ${actorUserId},
      ${idempotency.request_sha256}, 'authority_strict', NULL, NULL, NULL
    )
    ON CONFLICT (workspace_id, actor_user_id, route, idempotency_key)
      WHERE mode = 'authority_strict'
    DO NOTHING
    RETURNING id
  `;
  const eventWritten = sql/*sql*/`
    INSERT INTO operation_events (
      id, workspace_id, project_id, source_tool, agent_id, status, summary, body,
      visibility, occurred_at, authorized_by_user_id, instrument_kind, authority_source, request_id
    )
    SELECT
      ${spec.eventId}, entity.workspace_id,
      CASE WHEN entity.scope_type = 'project' THEN entity.scope_id ELSE NULL END,
      'xlooop', ${actorUserId}, 'completed', ${eventSummary(operation)},
      ${`Plan ${operation} persisted with strict replay and canonical readback.`},
      'internal_workspace', ${spec.commandTimestamp}::timestamptz, ${actorUserId},
      'human', 'role', ${idempotency.request_id ?? null}
    FROM plan_entities entity
    WHERE entity.id = ${entityId}
      AND entity.workspace_id = ${workspaceId}
      AND entity.updated_at = ${spec.commandTimestamp}::timestamptz
      AND (${operation}::text = 'delete' OR entity.deleted_at IS NULL)
      AND (${operation}::text <> 'delete' OR entity.deleted_at = ${spec.commandTimestamp}::timestamptz)
      AND EXISTS (
        SELECT 1 FROM idempotency_keys replay
        WHERE replay.workspace_id = ${workspaceId}
          AND replay.actor_user_id = ${actorUserId}
          AND replay.route = ${idempotency.route}
          AND replay.idempotency_key = ${idempotency.key}
          AND replay.request_sha256 = ${idempotency.request_sha256}
          AND replay.mode = 'authority_strict'
          AND replay.response_status IS NULL
      )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  const auditWritten = sql/*sql*/`
    INSERT INTO audit_logs (
      actor_user_id, action, target_type, target_id, workspace_id, reason, causation_id, metadata
    )
    SELECT
      ${actorUserId}, ${`plan_entity_${operation}`},
      CASE WHEN entity.scope_type = 'project' AND entity.scope_id IS NOT NULL THEN 'project' ELSE 'workspace' END,
      CASE WHEN entity.scope_type = 'project' AND entity.scope_id IS NOT NULL THEN entity.scope_id ELSE entity.workspace_id END,
      entity.workspace_id, ${`customer plan ${operation}`}, event.id,
      jsonb_build_object(
        'plan_entity_id', entity.id,
        'request_id', ${idempotency.request_id ?? null}::text,
        'request_sha256', ${idempotency.request_sha256}::text,
        'operation', ${operation}::text
      )
    FROM plan_entities entity
    JOIN operation_events event ON event.id = ${spec.eventId}
    WHERE entity.id = ${entityId} AND entity.workspace_id = ${workspaceId}
      AND entity.updated_at = ${spec.commandTimestamp}::timestamptz
    RETURNING id::text AS id
  `;
  const outboxWritten = sql/*sql*/`
    INSERT INTO projection_outbox (
      id, workspace_id, event_type, aggregate_type, aggregate_id, payload, created_at
    )
    SELECT
      ${spec.outboxId}, entity.workspace_id, ${`plan.entity_${operation}d`},
      'plan_entity', entity.id,
      jsonb_build_object(
        'plan_entity_id', entity.id,
        'scope_id', entity.scope_id,
        'operation_event_id', event.id,
        'audit_event_id', audit.id,
        'request_sha256', ${idempotency.request_sha256}::text
      ), ${spec.commandTimestamp}::timestamptz
    FROM plan_entities entity
    JOIN operation_events event ON event.id = ${spec.eventId}
    JOIN audit_logs audit ON audit.causation_id = event.id
      AND audit.workspace_id = entity.workspace_id
      AND audit.action = ${`plan_entity_${operation}`}
    WHERE entity.id = ${entityId} AND entity.workspace_id = ${workspaceId}
      AND entity.updated_at = ${spec.commandTimestamp}::timestamptz
    RETURNING id
  `;
  const completeReplay = sql/*sql*/`
    UPDATE idempotency_keys replay
    SET response_status = ${operation === 'create' ? 201 : 200},
        response_body = result.body,
        completed_at = ${spec.commandTimestamp}::timestamptz
    FROM (
      SELECT jsonb_build_object(
        'entity', CASE WHEN ${operation}::text = 'delete' THEN NULL ELSE to_jsonb(entity) - 'deleted_at' END,
        'deleted', CASE WHEN ${operation}::text = 'delete'
          THEN jsonb_build_object('id', entity.id, 'updated_at', ${spec.commandTimestamp}::text)
          ELSE NULL END,
        'plan_entity_id', entity.id,
        'plan_revision_id', ('plan:' || ${operation}::text || ':' || entity.id || ':' || ${spec.commandTimestamp}::text),
        'operation', ${operation}::text,
        'receipt_id', ('plan:' || ${operation}::text || ':' || entity.id || ':' || event.id),
        'operation_event_id', event.id,
        'audit_event_id', audit.id::text,
        'projection_outbox_id', outbox.id,
        'read_model_watermark', ${spec.commandTimestamp}::text,
        'replayed', false
      ) AS body
      FROM plan_entities entity
      JOIN operation_events event ON event.id = ${spec.eventId}
      JOIN audit_logs audit ON audit.causation_id = event.id
        AND audit.workspace_id = entity.workspace_id
        AND audit.action = ${`plan_entity_${operation}`}
      JOIN projection_outbox outbox ON outbox.id = ${spec.outboxId}
      WHERE entity.id = ${entityId} AND entity.workspace_id = ${workspaceId}
        AND entity.updated_at = ${spec.commandTimestamp}::timestamptz
    ) result
    WHERE replay.workspace_id = ${workspaceId}
      AND replay.actor_user_id = ${actorUserId}
      AND replay.route = ${idempotency.route}
      AND replay.idempotency_key = ${idempotency.key}
      AND replay.request_sha256 = ${idempotency.request_sha256}
      AND replay.mode = 'authority_strict'
      AND replay.response_status IS NULL
    RETURNING replay.response_body
  `;
  const assertAuthority = sql/*sql*/`
    SELECT xlooop_assert_authority_complete(
      replay.response_status IS NOT NULL
      AND replay.response_body IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM operation_events
        WHERE id = replay.response_body->>'operation_event_id'
          AND workspace_id = replay.workspace_id
      )
      AND EXISTS (
        SELECT 1 FROM audit_logs
        WHERE id::text = replay.response_body->>'audit_event_id'
          AND workspace_id = replay.workspace_id
      )
      AND EXISTS (
        SELECT 1 FROM projection_outbox
        WHERE id = replay.response_body->>'projection_outbox_id'
          AND workspace_id = replay.workspace_id
      ),
      ${`plan_entity_${operation}`}
    ) AS authority_complete
    FROM idempotency_keys replay
    WHERE replay.workspace_id = ${workspaceId}
      AND replay.actor_user_id = ${actorUserId}
      AND replay.route = ${idempotency.route}
      AND replay.idempotency_key = ${idempotency.key}
      AND replay.request_sha256 = ${idempotency.request_sha256}
      AND replay.mode = 'authority_strict'
  `;
  const readReplay = sql/*sql*/`
    SELECT request_sha256, response_status, response_body
    FROM idempotency_keys
    WHERE workspace_id = ${workspaceId}
      AND actor_user_id = ${actorUserId}
      AND route = ${idempotency.route}
      AND idempotency_key = ${idempotency.key}
      AND mode = 'authority_strict'
    LIMIT 1
  `;

  const queries = [
    claim,
    spec.lock,
    spec.mutation,
    ...(spec.repackShift ? [spec.repackShift] : []),
    ...(spec.repackFinish ? [spec.repackFinish] : []),
    eventWritten,
    auditWritten,
    outboxWritten,
    completeReplay,
    assertAuthority,
    readReplay,
  ];
  let results: unknown[][];
  try {
    results = await (sql as SqlTx).transaction(queries);
  } catch (error) {
    const sqlError = error as { code?: string; message?: string };
    if (sqlError.code === '23514' && sqlError.message?.includes(`plan_entity_${operation}`)) {
      throw makeError('CONFLICT', 'plan target changed or hierarchy is invalid; refresh and retry', 409);
    }
    throw error;
  }
  const completionRows = results.at(-3) as Array<{ response_body?: unknown }>;
  const replayRows = results.at(-1) as Array<{
    request_sha256?: string;
    response_status?: number | null;
    response_body?: unknown;
  }>;
  const replay = replayRows[0];
  if (replay?.request_sha256 && replay.request_sha256 !== idempotency.request_sha256) {
    throw makeError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request', 409);
  }
  if (!replay?.response_status || !replay.response_body) {
    await sql/*sql*/`
      DELETE FROM idempotency_keys
      WHERE workspace_id = ${workspaceId}
        AND actor_user_id = ${actorUserId}
        AND route = ${idempotency.route}
        AND idempotency_key = ${idempotency.key}
        AND request_sha256 = ${idempotency.request_sha256}
        AND mode = 'authority_strict'
        AND response_status IS NULL
    `;
    throw makeError('PLAN_ATOMICITY_FAILED', `plan ${operation} produced no complete authority result`, 409);
  }
  return receiptFromBody(replay.response_body, completionRows.length === 0);
}
