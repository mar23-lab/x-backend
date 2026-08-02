// plan-command-operations.ts · validated SQL operations for authority-grade plan commands.

import type { Sql } from '../db/client';
import type {
  PlanEntity,
  PlanEntityAuthorityReceipt,
  PlanEntityCreateInput,
  PlanEntityMutationIdempotencyInput,
  PlanEntityPatch,
  UserId,
  WorkspaceId,
} from './types';
import { makeError, randomNanoid } from './shared-helpers';
import {
  executePlanEntityCommand,
  planRouteIdentity,
  validatePlanIdempotency,
  type PlanEntityCommandTarget,
} from './plan-command-store';

const REPACK_OFFSET = 1_000_000;

function siblingLock(
  sql: Sql,
  target: PlanEntityCommandTarget,
  newParentId: string | null,
): unknown {
  return sql/*sql*/`
    SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
    FROM unnest(ARRAY[
      (${target.workspace_id}::text || ':' || COALESCE(${target.scope_id}::text, '') || ':' || COALESCE(${target.parent_id}::text, '')),
      (${target.workspace_id}::text || ':' || COALESCE(${target.scope_id}::text, '') || ':' || COALESCE(${newParentId}::text, ''))
    ]) lock_key
    WHERE EXISTS (
      SELECT 1 FROM plan_entities
      WHERE id = ${target.id} AND workspace_id = ${target.workspace_id} AND deleted_at IS NULL
    )
    GROUP BY lock_key
    ORDER BY lock_key
  `;
}

function repackQueries(
  sql: Sql,
  target: PlanEntityCommandTarget,
  newParentId: string | null,
  requestedPosition: number,
  commandTimestamp: string,
): [unknown, unknown] {
  const shifted = sql/*sql*/`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY scope_id, parent_id
        ORDER BY
          (CASE WHEN id = ${target.id} THEN ${requestedPosition} ELSE position END),
          (CASE WHEN id = ${target.id} THEN 0 ELSE 1 END), updated_at, id
      ) - 1 AS new_pos
      FROM plan_entities
      WHERE workspace_id = ${target.workspace_id}
        AND scope_id IS NOT DISTINCT FROM ${target.scope_id}::text
        AND deleted_at IS NULL
        AND (parent_id IS NOT DISTINCT FROM ${target.parent_id}::text
          OR parent_id IS NOT DISTINCT FROM ${newParentId}::text)
        AND EXISTS (
          SELECT 1 FROM plan_entities command_target
          WHERE command_target.id = ${target.id}
            AND command_target.workspace_id = ${target.workspace_id}
            AND command_target.updated_at = ${commandTimestamp}::timestamptz
        )
    )
    UPDATE plan_entities entity SET position = ranked.new_pos + ${REPACK_OFFSET}
    FROM ranked WHERE entity.id = ranked.id
  `;
  const finished = sql/*sql*/`
    UPDATE plan_entities SET position = position - ${REPACK_OFFSET}
    WHERE workspace_id = ${target.workspace_id}
      AND scope_id IS NOT DISTINCT FROM ${target.scope_id}::text
      AND deleted_at IS NULL
      AND (parent_id IS NOT DISTINCT FROM ${target.parent_id}::text
        OR parent_id IS NOT DISTINCT FROM ${newParentId}::text)
      AND position >= ${REPACK_OFFSET}
      AND EXISTS (
        SELECT 1 FROM plan_entities command_target
        WHERE command_target.id = ${target.id}
          AND command_target.workspace_id = ${target.workspace_id}
          AND command_target.updated_at = ${commandTimestamp}::timestamptz
      )
  `;
  return [shifted, finished];
}

export async function createPlanEntityWithAuthorityRow(
  sql: Sql,
  input: PlanEntityCreateInput,
  actorUserId: UserId,
  idempotency: PlanEntityMutationIdempotencyInput,
): Promise<PlanEntityAuthorityReceipt> {
  validatePlanIdempotency(idempotency, planRouteIdentity('create'));
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!input.workspace_id) throw makeError('VALIDATION_ERROR', 'workspace_id required', 400);
  if (!input.title || input.title.length > 200) throw makeError('VALIDATION_ERROR', 'title 1-200 chars required', 400);
  const entityId = `ple_${randomNanoid()}`;
  const commandTimestamp = new Date().toISOString();
  const eventId = `evt_${randomNanoid()}`;
  const outboxId = `out_${randomNanoid()}`;
  const scopeId = input.scope_id ?? null;
  const parentId = input.parent_id ?? null;
  const lock = sql/*sql*/`
    SELECT pg_advisory_xact_lock(hashtextextended(
      ${input.workspace_id}::text || ':' || COALESCE(${scopeId}::text, '') || ':' || COALESCE(${parentId}::text, ''), 0
    ))
  `;
  const mutation = sql/*sql*/`
    INSERT INTO plan_entities (
      id, workspace_id, scope_id, scope_type, parent_id, kind, title, summary, status, position,
      target_date, created_by, updated_by, created_at, updated_at
    )
    SELECT
      ${entityId}, ${input.workspace_id}, ${scopeId}::text, ${input.scope_type ?? null}::text,
      ${parentId}::text, ${input.kind}, ${input.title}, ${input.summary ?? null}, 'open',
      COALESCE((
        SELECT MAX(position) + 1 FROM plan_entities sibling
        WHERE sibling.workspace_id = ${input.workspace_id}
          AND sibling.scope_id IS NOT DISTINCT FROM ${scopeId}::text
          AND sibling.parent_id IS NOT DISTINCT FROM ${parentId}::text
          AND sibling.deleted_at IS NULL
      ), 0),
      ${input.target_date ?? null}::date, ${actorUserId}, ${actorUserId},
      ${commandTimestamp}::timestamptz, ${commandTimestamp}::timestamptz
    WHERE EXISTS (
      SELECT 1 FROM idempotency_keys replay
      WHERE replay.workspace_id = ${input.workspace_id}
        AND replay.actor_user_id = ${actorUserId}
        AND replay.route = ${idempotency.route}
        AND replay.idempotency_key = ${idempotency.key}
        AND replay.request_sha256 = ${idempotency.request_sha256}
        AND replay.mode = 'authority_strict' AND replay.response_status IS NULL
    )
      AND (${parentId}::text IS NULL OR EXISTS (
        SELECT 1 FROM plan_entities parent
        WHERE parent.id = ${parentId} AND parent.workspace_id = ${input.workspace_id}
          AND parent.scope_id IS NOT DISTINCT FROM ${scopeId}::text AND parent.deleted_at IS NULL
      ))
    RETURNING id
  `;
  return executePlanEntityCommand(sql, {
    operation: 'create', entityId, workspaceId: input.workspace_id, actorUserId, idempotency,
    commandTimestamp, eventId, outboxId, lock, mutation,
  });
}

export async function updatePlanEntityWithAuthorityRow(
  sql: Sql,
  target: PlanEntityCommandTarget,
  patch: PlanEntityPatch,
  actorUserId: UserId,
  idempotency: PlanEntityMutationIdempotencyInput,
): Promise<PlanEntityAuthorityReceipt> {
  validatePlanIdempotency(idempotency, planRouteIdentity('update', target.id));
  if (patch.title !== undefined && (!patch.title || patch.title.length > 200)) {
    throw makeError('VALIDATION_ERROR', 'title 1-200 chars required', 400);
  }
  const commandTimestamp = new Date().toISOString();
  const eventId = `evt_${randomNanoid()}`;
  const outboxId = `out_${randomNanoid()}`;
  const parentProvided = Object.prototype.hasOwnProperty.call(patch, 'parent_id');
  const newParentId = parentProvided ? (patch.parent_id ?? null) : target.parent_id;
  const requestedPosition = patch.position ?? target.position;
  const move = parentProvided || patch.position !== undefined;
  const lock = siblingLock(sql, target, newParentId);
  const mutation = sql/*sql*/`
    WITH RECURSIVE descendants AS (
      SELECT child.id
      FROM plan_entities child
      WHERE child.workspace_id = ${target.workspace_id}
        AND child.scope_id IS NOT DISTINCT FROM ${target.scope_id}::text
        AND child.parent_id = ${target.id}
        AND child.deleted_at IS NULL
      UNION
      SELECT child.id
      FROM plan_entities child
      JOIN descendants parent ON child.parent_id = parent.id
      WHERE child.workspace_id = ${target.workspace_id}
        AND child.scope_id IS NOT DISTINCT FROM ${target.scope_id}::text
        AND child.deleted_at IS NULL
    )
    UPDATE plan_entities entity SET
      title = COALESCE(${patch.title ?? null}, entity.title),
      status = COALESCE(${patch.status ?? null}, entity.status),
      position = CASE WHEN ${move}::boolean THEN ${requestedPosition + (2 * REPACK_OFFSET)} ELSE entity.position END,
      parent_id = CASE WHEN ${parentProvided}::boolean THEN ${newParentId}::text ELSE entity.parent_id END,
      updated_by = ${actorUserId}, updated_at = ${commandTimestamp}::timestamptz
    WHERE entity.id = ${target.id}
      AND entity.workspace_id = ${target.workspace_id}
      AND entity.updated_at = ${target.updated_at}::timestamptz
      AND entity.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM idempotency_keys replay
        WHERE replay.workspace_id = ${target.workspace_id}
          AND replay.actor_user_id = ${actorUserId}
          AND replay.route = ${idempotency.route}
          AND replay.idempotency_key = ${idempotency.key}
          AND replay.request_sha256 = ${idempotency.request_sha256}
          AND replay.mode = 'authority_strict' AND replay.response_status IS NULL
      )
      AND (${newParentId}::text IS NULL OR EXISTS (
        SELECT 1 FROM plan_entities parent
        WHERE parent.id = ${newParentId} AND parent.id <> ${target.id}
          AND parent.workspace_id = ${target.workspace_id}
          AND parent.scope_id IS NOT DISTINCT FROM ${target.scope_id}::text
          AND parent.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM descendants WHERE id = parent.id)
      ))
    RETURNING id
  `;
  const [repackShift, repackFinish] = move
    ? repackQueries(sql, target, newParentId, requestedPosition, commandTimestamp)
    : [undefined, undefined];
  return executePlanEntityCommand(sql, {
    operation: 'update', entityId: target.id, workspaceId: target.workspace_id, actorUserId,
    idempotency, commandTimestamp, eventId, outboxId, lock, mutation, repackShift, repackFinish,
  });
}

export async function deletePlanEntityWithAuthorityRow(
  sql: Sql,
  target: PlanEntityCommandTarget,
  actorUserId: UserId,
  idempotency: PlanEntityMutationIdempotencyInput,
): Promise<PlanEntityAuthorityReceipt> {
  validatePlanIdempotency(idempotency, planRouteIdentity('delete', target.id));
  const commandTimestamp = new Date().toISOString();
  const eventId = `evt_${randomNanoid()}`;
  const outboxId = `out_${randomNanoid()}`;
  const lock = siblingLock(sql, target, target.parent_id);
  const mutation = sql/*sql*/`
    UPDATE plan_entities entity
    SET deleted_at = ${commandTimestamp}::timestamptz,
        updated_at = ${commandTimestamp}::timestamptz, updated_by = ${actorUserId}
    WHERE entity.id = ${target.id}
      AND entity.workspace_id = ${target.workspace_id}
      AND entity.updated_at = ${target.updated_at}::timestamptz
      AND entity.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM idempotency_keys replay
        WHERE replay.workspace_id = ${target.workspace_id}
          AND replay.actor_user_id = ${actorUserId}
          AND replay.route = ${idempotency.route}
          AND replay.idempotency_key = ${idempotency.key}
          AND replay.request_sha256 = ${idempotency.request_sha256}
          AND replay.mode = 'authority_strict' AND replay.response_status IS NULL
      )
    RETURNING id
  `;
  const repackShift = sql/*sql*/`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY position, updated_at, id) - 1 AS new_pos
      FROM plan_entities
      WHERE workspace_id = ${target.workspace_id}
        AND scope_id IS NOT DISTINCT FROM ${target.scope_id}::text
        AND parent_id IS NOT DISTINCT FROM ${target.parent_id}::text
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM plan_entities deleted_target
          WHERE deleted_target.id = ${target.id}
            AND deleted_target.workspace_id = ${target.workspace_id}
            AND deleted_target.deleted_at = ${commandTimestamp}::timestamptz
        )
    )
    UPDATE plan_entities entity SET position = ranked.new_pos + ${REPACK_OFFSET}
    FROM ranked WHERE entity.id = ranked.id
  `;
  const repackFinish = sql/*sql*/`
    UPDATE plan_entities SET position = position - ${REPACK_OFFSET}
    WHERE workspace_id = ${target.workspace_id}
      AND scope_id IS NOT DISTINCT FROM ${target.scope_id}::text
      AND parent_id IS NOT DISTINCT FROM ${target.parent_id}::text
      AND deleted_at IS NULL AND position >= ${REPACK_OFFSET}
      AND EXISTS (
        SELECT 1 FROM plan_entities deleted_target
        WHERE deleted_target.id = ${target.id}
          AND deleted_target.workspace_id = ${target.workspace_id}
          AND deleted_target.deleted_at = ${commandTimestamp}::timestamptz
      )
  `;
  return executePlanEntityCommand(sql, {
    operation: 'delete', entityId: target.id, workspaceId: target.workspace_id, actorUserId,
    idempotency, commandTimestamp, eventId, outboxId, lock, mutation, repackShift, repackFinish,
  });
}

export function commandTargetFromEntity(entity: PlanEntity): PlanEntityCommandTarget {
  return {
    id: entity.id,
    workspace_id: entity.workspace_id,
    scope_id: entity.scope_id,
    scope_type: entity.scope_type,
    parent_id: entity.parent_id,
    position: entity.position,
    updated_at: entity.updated_at,
  };
}
