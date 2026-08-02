// project-mutation-store.ts · strict transactional project rename and archive authority.

import type { Sql } from '../db/client';
import { assertWorkspaceScope } from './DalAdapter';
import { makeError, randomNanoid } from './shared-helpers';
import type {
  ProjectMutationAuthorityInput,
  ProjectMutationAuthorityReceipt,
  ProjectMutationIdempotencyInput,
  UserId,
} from './types';

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function mutationReceiptFromBody(body: unknown, replayed: boolean): ProjectMutationAuthorityReceipt {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw makeError('INTERNAL_ERROR', 'strict project mutation replay body is unavailable', 500);
  }
  const row = body as Partial<ProjectMutationAuthorityReceipt>;
  if (
    !row.project?.id
    || (row.mutation_kind !== 'update' && row.mutation_kind !== 'archive')
    || !row.receipt_id
    || !row.operation_event_id
    || !row.audit_event_id
    || !row.projection_outbox_id
    || !row.read_model_watermark
  ) {
    throw makeError('INTERNAL_ERROR', 'strict project mutation replay body is incomplete', 500);
  }
  return { ...row, replayed } as ProjectMutationAuthorityReceipt;
}

async function readStrictMutationReplay(
  sql: Sql,
  workspaceId: string,
  actorUserId: string,
  idempotency: ProjectMutationIdempotencyInput,
): Promise<ProjectMutationAuthorityReceipt> {
  const rows = (await sql/*sql*/`
    SELECT request_sha256, response_status, response_body
    FROM idempotency_keys
    WHERE workspace_id = ${workspaceId}
      AND actor_user_id = ${actorUserId}
      AND route = ${idempotency.route}
      AND idempotency_key = ${idempotency.key}
      AND mode = 'authority_strict'
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw makeError('INTERNAL_ERROR', 'strict project mutation did not create a replay record', 500);
  if (row.request_sha256 !== idempotency.request_sha256) {
    throw makeError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request', 409);
  }
  if (row.response_status == null || row.response_body == null) {
    throw makeError('PROJECT_ATOMICITY_FAILED', 'project mutation has no durable authority result', 500);
  }
  return mutationReceiptFromBody(row.response_body, true);
}

/**
 * PATCH/DELETE /projects/:id authority transaction.
 *
 * The target row, operation event, audit record, projection outbox, and replay response are one
 * SQL authority result. A missing target or any missing lineage row rolls the entire statement back.
 */
export async function mutateProjectWithAuthorityRow(
  sql: Sql,
  input: ProjectMutationAuthorityInput,
  actorUserId: UserId,
  idempotency: ProjectMutationIdempotencyInput,
): Promise<ProjectMutationAuthorityReceipt> {
  assertWorkspaceScope(input.workspace_id);
  const actor = clean(actorUserId);
  const projectId = clean(input.project_id);
  const key = clean(idempotency.key);
  if (!actor) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project id required', 400);
  if (!key || key.length > 200) throw makeError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required (1-200 chars)', 428);
  if (!/^[a-f0-9]{64}$/.test(idempotency.request_sha256)) {
    throw makeError('VALIDATION_ERROR', 'request_sha256 must be a lower-case SHA-256 value', 400);
  }
  const expectedRoute = input.mutation_kind === 'archive'
    ? 'DELETE /api/v1/projects/:id'
    : 'PATCH /api/v1/projects/:id';
  if (idempotency.route !== expectedRoute) {
    throw makeError('VALIDATION_ERROR', 'strict project mutation route identity is invalid', 400);
  }

  const patch = input.patch ?? {};
  const hasName = Object.prototype.hasOwnProperty.call(patch, 'name');
  const hasDescription = Object.prototype.hasOwnProperty.call(patch, 'description');
  const hasStatus = Object.prototype.hasOwnProperty.call(patch, 'status');
  const name = hasName ? clean(patch.name) : null;
  const description = hasDescription ? (patch.description ?? null) : null;
  const status = hasStatus ? clean(patch.status) : null;
  if (hasName && (!name || name.length > 200)) {
    throw makeError('VALIDATION_ERROR', 'name must be 1-200 chars', 400);
  }
  if (!hasName && !hasDescription && !hasStatus) {
    throw makeError('VALIDATION_ERROR', 'project mutation must change at least one field', 400);
  }
  if (input.mutation_kind === 'archive' && status !== 'archived') {
    throw makeError('VALIDATION_ERROR', 'archive mutation must set status=archived', 400);
  }

  const operationEventId = `evt_${randomNanoid()}`;
  const projectionOutboxId = `out_${randomNanoid()}`;
  const commandTimestamp = new Date().toISOString();
  const action = input.mutation_kind === 'archive' ? 'project_archive' : 'project_update';
  const eventType = input.mutation_kind === 'archive' ? 'project.archived' : 'project.updated';
  const eventSummaryPrefix = input.mutation_kind === 'archive' ? 'Project archived: ' : 'Project updated: ';
  const eventBody = input.mutation_kind === 'archive'
    ? 'Project soft-archived through a reversible authority command.'
    : 'Project fields updated through an authority command.';

  let rows: Array<{ response_body: unknown }>;
  try {
    rows = (await sql/*sql*/`
      WITH existing_replay AS (
        SELECT id
        FROM idempotency_keys
        WHERE workspace_id = ${input.workspace_id}
          AND actor_user_id = ${actor}
          AND route = ${idempotency.route}
          AND idempotency_key = ${key}
          AND mode = 'authority_strict'
        LIMIT 1
      ),
      command_envelope AS (
        SELECT nextval(pg_get_serial_sequence('audit_logs', 'id'))::bigint AS audit_id
        WHERE NOT EXISTS (SELECT 1 FROM existing_replay)
      ),
      target_updated AS (
        UPDATE projects
        SET
          name = CASE WHEN ${hasName}::boolean THEN ${name}::text ELSE name END,
          description = CASE WHEN ${hasDescription}::boolean THEN ${description}::text ELSE description END,
          status = CASE WHEN ${hasStatus}::boolean THEN ${status}::text ELSE status END,
          updated_at = ${commandTimestamp}::timestamptz
        FROM command_envelope
        WHERE projects.workspace_id = ${input.workspace_id}
          AND projects.id = ${projectId}
        RETURNING projects.id, projects.workspace_id, projects.name, projects.status,
                  projects.description, projects.metadata, projects.scope_binding,
                  projects.scope_binding_updated_at, projects.scope_binding_updated_by,
                  projects.parent_project_id, projects.created_at, projects.updated_at
      ),
      event_written AS (
        INSERT INTO operation_events (
          id, workspace_id, project_id, source_tool, agent_id, status, summary,
          body, visibility, occurred_at, authorized_by_user_id, instrument_kind,
          authority_source, request_id
        )
        SELECT
          ${operationEventId}, target_updated.workspace_id, target_updated.id,
          'xlooop', ${actor}, 'completed', (${eventSummaryPrefix} || target_updated.name),
          ${eventBody}, 'internal_workspace', ${commandTimestamp}::timestamptz,
          ${actor}, 'human', 'role', ${idempotency.request_id ?? null}
        FROM target_updated
        RETURNING id, occurred_at
      ),
      audit_written AS (
        INSERT INTO audit_logs (
          id, actor_user_id, action, target_type, target_id, workspace_id, reason,
          causation_id, metadata
        )
        SELECT
          command_envelope.audit_id, ${actor}, ${action}, 'project', target_updated.id,
          target_updated.workspace_id, ${eventBody}, event_written.id,
          jsonb_build_object(
            'request_id', ${idempotency.request_id ?? null}::text,
            'request_sha256', ${idempotency.request_sha256}::text,
            'mutation_kind', ${input.mutation_kind}::text
          )
        FROM target_updated
        JOIN event_written ON TRUE
        JOIN command_envelope ON TRUE
        RETURNING id::text AS audit_event_id
      ),
      outbox_written AS (
        INSERT INTO projection_outbox (
          id, workspace_id, event_type, aggregate_type, aggregate_id, payload, created_at
        )
        SELECT
          ${projectionOutboxId}, target_updated.workspace_id, ${eventType}, 'project',
          target_updated.id,
          jsonb_build_object(
            'project_id', target_updated.id,
            'mutation_kind', ${input.mutation_kind}::text,
            'operation_event_id', event_written.id,
            'audit_event_id', audit_written.audit_event_id,
            'request_sha256', ${idempotency.request_sha256}::text
          ),
          ${commandTimestamp}::timestamptz
        FROM target_updated
        JOIN event_written ON TRUE
        JOIN audit_written ON TRUE
        RETURNING id, created_at
      ),
      strict_claim AS (
        INSERT INTO idempotency_keys (
          workspace_id, idempotency_key, route, actor_user_id, request_sha256, mode,
          response_status, response_body, completed_at
        )
        SELECT
          ${input.workspace_id}, ${key}, ${idempotency.route}, ${actor},
          ${idempotency.request_sha256}, 'authority_strict', 200,
          jsonb_build_object(
            'project', to_jsonb(target_updated),
            'mutation_kind', ${input.mutation_kind}::text,
            'receipt_id', ('project-' || ${input.mutation_kind}::text || ':' || target_updated.id || ':' || audit_written.audit_event_id),
            'operation_event_id', event_written.id,
            'audit_event_id', audit_written.audit_event_id,
            'projection_outbox_id', outbox_written.id,
            'read_model_watermark', ${commandTimestamp}::text,
            'replayed', false
          ),
          ${commandTimestamp}::timestamptz
        FROM target_updated
        JOIN event_written ON TRUE
        JOIN audit_written ON TRUE
        JOIN outbox_written ON TRUE
        RETURNING response_body
      ),
      authority_result AS (
        SELECT
          strict_claim.response_body,
          CASE
            WHEN (SELECT count(*) FROM target_updated) <> 1 THEN
              xlooop_assert_authority_complete(false, 'project_mutation_target')
            ELSE
              xlooop_assert_authority_complete(
                (SELECT count(*) FROM event_written) = 1
                AND (SELECT count(*) FROM audit_written) = 1
                AND (SELECT count(*) FROM outbox_written) = 1
                AND (SELECT count(*) FROM strict_claim) = 1,
                'project_mutation'
              )
          END AS authority_complete
        FROM command_envelope
        LEFT JOIN strict_claim ON TRUE
      )
      SELECT response_body
      FROM authority_result
      WHERE authority_complete
    `) as Array<{ response_body: unknown }>;
  } catch (error) {
    const sqlError = error as { code?: string; constraint?: string; message?: string };
    if (
      sqlError.code === '23505'
      && (sqlError.constraint === 'idempotency_keys_authority_key'
        || sqlError.message?.includes('idempotency_keys_authority_key'))
    ) {
      return readStrictMutationReplay(sql, input.workspace_id, actor, idempotency);
    }
    if (sqlError.code === '23514' && sqlError.message?.includes('project_mutation_target')) {
      throw makeError('NOT_FOUND', `project ${projectId} not found`, 404);
    }
    if (sqlError.code === '23514' && sqlError.message?.includes('xlooop authority incomplete')) {
      throw makeError('PROJECT_ATOMICITY_FAILED', 'project mutation did not complete every authority row', 500);
    }
    throw error;
  }

  if (rows[0]?.response_body) return mutationReceiptFromBody(rows[0].response_body, false);
  return readStrictMutationReplay(sql, input.workspace_id, actor, idempotency);
}
