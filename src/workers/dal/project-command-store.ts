// project-command-store.ts · authority-grade project creation and optional initial framing.
//
// POST /projects is one command: project, initial goal, source bindings, event, audit, outbox, and
// strict replay response are persisted by one SQL statement. A caller retry never re-runs the command.

import type { Sql } from '../db/client';
import { assertWorkspaceScope } from './DalAdapter';
import { makeError, randomNanoid } from './shared-helpers';
import type {
  ProjectCreateAuthorityInput,
  ProjectCreateAuthorityReceipt,
  ProjectCreateIdempotencyInput,
  ProjectSourceBindingInput,
  UserId,
} from './types';

const SOURCE_KINDS = new Set(['github_repo', 'google_drive_folder', 'desktop_folder', 'manual']);
const SOURCE_STATUSES = new Set(['pending_auth', 'connected', 'reconnect_required', 'disabled_preview', 'archived']);
const SOURCE_READ_POLICIES = new Set(['metadata_only', 'proposal_only', 'read_only']);

interface PreparedSourceBinding extends ProjectSourceBindingInput {
  id: string;
}

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function validateSourceBinding(input: ProjectSourceBindingInput, index: number): void {
  if (!input || typeof input !== 'object') {
    throw makeError('VALIDATION_ERROR', `source_bindings[${index}] must be an object`, 400);
  }
  if (!SOURCE_KINDS.has(input.source_kind)) {
    throw makeError('VALIDATION_ERROR', `source_bindings[${index}].source_kind is invalid`, 400);
  }
  if (input.status !== undefined && !SOURCE_STATUSES.has(input.status)) {
    throw makeError('VALIDATION_ERROR', `source_bindings[${index}].status is invalid`, 400);
  }
  if (input.read_policy !== undefined && !SOURCE_READ_POLICIES.has(input.read_policy)) {
    throw makeError('VALIDATION_ERROR', `source_bindings[${index}].read_policy is invalid`, 400);
  }
  if (input.source_ref !== undefined && (!input.source_ref || typeof input.source_ref !== 'object' || Array.isArray(input.source_ref))) {
    throw makeError('VALIDATION_ERROR', `source_bindings[${index}].source_ref must be an object`, 400);
  }
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
    throw makeError('VALIDATION_ERROR', `source_bindings[${index}].metadata must be an object`, 400);
  }
}

function receiptFromBody(body: unknown, replayed: boolean): ProjectCreateAuthorityReceipt {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw makeError('INTERNAL_ERROR', 'strict project replay body is unavailable', 500);
  }
  const row = body as Partial<ProjectCreateAuthorityReceipt>;
  if (
    !row.project?.id
    || !row.receipt_id
    || !row.operation_event_id
    || !row.audit_event_id
    || !row.projection_outbox_id
    || !row.read_model_watermark
    || !Array.isArray(row.source_bindings)
  ) {
    throw makeError('INTERNAL_ERROR', 'strict project replay body is incomplete', 500);
  }
  return { ...row, replayed } as ProjectCreateAuthorityReceipt;
}

async function readStrictReplay(
  sql: Sql,
  workspaceId: string,
  actorUserId: string,
  idempotency: ProjectCreateIdempotencyInput,
): Promise<ProjectCreateAuthorityReceipt> {
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
  if (!row) throw makeError('INTERNAL_ERROR', 'strict project command did not create a replay record', 500);
  if (row.request_sha256 !== idempotency.request_sha256) {
    throw makeError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request', 409);
  }
  if (row.response_status == null || row.response_body == null) {
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
    throw makeError('PROJECT_ATOMICITY_FAILED', 'project command produced no durable authority result; retry with the same key', 500);
  }
  return receiptFromBody(row.response_body, true);
}

export async function createProjectWithAuthorityRow(
  sql: Sql,
  input: ProjectCreateAuthorityInput,
  actorUserId: UserId,
  idempotency: ProjectCreateIdempotencyInput,
): Promise<ProjectCreateAuthorityReceipt> {
  assertWorkspaceScope(input.workspace_id);
  const actor = clean(actorUserId);
  const key = clean(idempotency.key);
  const name = clean(input.name);
  if (!actor) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!name || name.length > 200) throw makeError('VALIDATION_ERROR', 'name 1-200 chars required', 400);
  if (!key || key.length > 200) throw makeError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required (1-200 chars)', 428);
  if (!/^[a-f0-9]{64}$/.test(idempotency.request_sha256)) {
    throw makeError('VALIDATION_ERROR', 'request_sha256 must be a lower-case SHA-256 value', 400);
  }
  if (idempotency.route !== 'POST /api/v1/projects') {
    throw makeError('VALIDATION_ERROR', 'strict project route identity is invalid', 400);
  }
  const goal = input.initial_goal ?? null;
  if (goal && (!clean(goal.title) || clean(goal.title).length > 200)) {
    throw makeError('VALIDATION_ERROR', 'initial_goal.title must be 1-200 chars', 400);
  }
  if (goal?.target_date && !/^\d{4}-\d{2}-\d{2}$/.test(goal.target_date)) {
    throw makeError('VALIDATION_ERROR', 'initial_goal.target_date must be YYYY-MM-DD', 400);
  }
  const sources = input.source_bindings ?? [];
  if (!Array.isArray(sources) || sources.length > 20) {
    throw makeError('VALIDATION_ERROR', 'source_bindings must contain at most 20 entries', 400);
  }
  sources.forEach(validateSourceBinding);

  const projectId = clean(input.id) || `proj_${randomNanoid()}`;
  const goalId = goal ? `ple_${randomNanoid()}` : null;
  const operationEventId = `evt_${randomNanoid()}`;
  const projectionOutboxId = `out_${randomNanoid()}`;
  const commandTimestamp = new Date().toISOString();
  const preparedSources: PreparedSourceBinding[] = sources.map((source) => ({
    ...source,
    id: `psb_${randomNanoid()}`,
    domain_id: source.domain_id ?? null,
    user_source_connection_id: source.user_source_connection_id ?? null,
    source_ref: source.source_ref ?? {},
    status: source.status ?? 'pending_auth',
    read_policy: source.read_policy ?? 'metadata_only',
    reconnect_required_reason: source.reconnect_required_reason ?? null,
    metadata: source.metadata ?? {},
  }));
  const projectRecord = {
    id: projectId,
    workspace_id: input.workspace_id,
    name,
    status: input.status ?? 'active',
    description: input.description ?? null,
    metadata: input.metadata ?? {},
    scope_binding: null,
    scope_binding_updated_at: null,
    scope_binding_updated_by: null,
    parent_project_id: input.parent_project_id ?? null,
    created_at: commandTimestamp,
    updated_at: commandTimestamp,
  };
  const goalRecord = goal ? {
    id: goalId,
    workspace_id: input.workspace_id,
    scope_id: projectId,
    scope_type: 'project',
    parent_id: null,
    kind: 'goal',
    title: clean(goal.title),
    summary: goal.summary ?? null,
    status: 'open',
    position: 0,
    target_date: goal.target_date ?? null,
    derived_from: null,
    promoted_to_intent_id: null,
    created_by: actor,
    updated_by: actor,
    created_at: commandTimestamp,
    updated_at: commandTimestamp,
  } : null;
  const canonicalSources = preparedSources.map((source) => ({
    ...source,
    workspace_id: input.workspace_id,
    project_id: projectId,
    connected_by: actor,
    connected_at: source.status === 'connected' ? commandTimestamp : null,
    last_verified_at: source.status === 'connected' ? commandTimestamp : null,
    created_at: commandTimestamp,
    updated_at: commandTimestamp,
  }));
  const projectJson = JSON.stringify(projectRecord);
  const goalJson = JSON.stringify(goalRecord);
  const sourceJson = JSON.stringify(canonicalSources);
  const expectedSourceCount = preparedSources.length;
  const expectedGoalCount = goal ? 1 : 0;

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
    strict_claim AS (
      INSERT INTO idempotency_keys (
        workspace_id, idempotency_key, route, actor_user_id, request_sha256, mode,
        response_status, response_body, completed_at
      )
      SELECT
        ${input.workspace_id}, ${key}, ${idempotency.route}, ${actor},
        ${idempotency.request_sha256}, 'authority_strict', 201,
        jsonb_build_object(
          'project', ${projectJson}::jsonb,
          'initial_goal', ${goalJson}::jsonb,
          'source_bindings', ${sourceJson}::jsonb,
          'receipt_id', ('project-create:' || ${projectId}::text || ':' || command_envelope.audit_id::text),
          'operation_event_id', ${operationEventId}::text,
          'audit_event_id', command_envelope.audit_id::text,
          'projection_outbox_id', ${projectionOutboxId}::text,
          'read_model_watermark', ${commandTimestamp}::text,
          'replayed', false
        ),
        ${commandTimestamp}::timestamptz
      FROM command_envelope
      RETURNING id, response_body
    ),
    parent_checked AS (
      SELECT strict_claim.id AS claim_id
      FROM strict_claim
      WHERE ${input.parent_project_id ?? null}::text IS NULL
         OR EXISTS (
           SELECT 1
           FROM projects parent
           WHERE parent.id = ${input.parent_project_id ?? null}::text
             AND parent.workspace_id = ${input.workspace_id}
         )
    ),
    project_written AS (
      INSERT INTO projects (
        id, workspace_id, name, status, description, metadata, parent_project_id,
        created_at, updated_at
      )
      SELECT
        ${projectId}, ${input.workspace_id}, ${name}, ${input.status ?? 'active'},
        ${input.description ?? null}, ${JSON.stringify(input.metadata ?? {})}::jsonb,
        ${input.parent_project_id ?? null}::text,
        ${commandTimestamp}::timestamptz, ${commandTimestamp}::timestamptz
      FROM parent_checked
      RETURNING id, workspace_id, name, status, description, metadata,
                scope_binding, scope_binding_updated_at, scope_binding_updated_by,
                parent_project_id, created_at, updated_at
    ),
    goal_written AS (
      INSERT INTO plan_entities (
        id, workspace_id, scope_id, scope_type, parent_id, kind, title, summary,
        status, position, target_date, created_by, updated_by, created_at, updated_at
      )
      SELECT
        ${goalId}, project_written.workspace_id, project_written.id, 'project', NULL,
        'goal', ${goal ? clean(goal.title) : null}, ${goal?.summary ?? null}, 'open', 0,
        ${goal?.target_date ?? null}::date, ${actor}, ${actor},
        ${commandTimestamp}::timestamptz, ${commandTimestamp}::timestamptz
      FROM project_written
      WHERE ${goalId}::text IS NOT NULL
      RETURNING id, workspace_id, scope_id, scope_type, parent_id, kind, title,
                summary, status, position, target_date, derived_from,
                promoted_to_intent_id, created_by, updated_by, created_at, updated_at
    ),
    source_input AS (
      SELECT *
      FROM jsonb_to_recordset(${sourceJson}::jsonb) AS source_row(
        id text,
        source_kind text,
        domain_id text,
        user_source_connection_id text,
        source_ref jsonb,
        status text,
        read_policy text,
        reconnect_required_reason text,
        metadata jsonb,
        connected_by text,
        connected_at timestamptz,
        last_verified_at timestamptz,
        created_at timestamptz,
        updated_at timestamptz
      )
    ),
    source_connections_locked AS MATERIALIZED (
      SELECT connection.id, connection.user_id, connection.workspace_id,
             connection.provider, connection.status
      FROM user_source_connections connection
      WHERE connection.user_id = ${actor}
        AND connection.workspace_id = ${input.workspace_id}
        AND connection.id IN (
          SELECT source_input.user_source_connection_id
          FROM source_input
          WHERE source_input.user_source_connection_id IS NOT NULL
        )
      FOR SHARE
    ),
    source_eligibility AS (
      SELECT source_input.*
      FROM source_input
      WHERE (
          source_input.source_kind IN ('manual', 'desktop_folder')
          AND source_input.user_source_connection_id IS NULL
        )
        OR (
          source_input.source_kind = 'github_repo'
          AND (
            (
              source_input.user_source_connection_id IS NULL
              AND source_input.status <> 'connected'
            )
            OR EXISTS (
              SELECT 1
              FROM source_connections_locked connection
              WHERE connection.id = source_input.user_source_connection_id
                AND connection.provider = 'github'
                AND (source_input.status <> 'connected' OR connection.status = 'connected')
            )
          )
        )
        OR (
          source_input.source_kind = 'google_drive_folder'
          AND (
            (
              source_input.user_source_connection_id IS NULL
              AND source_input.status <> 'connected'
            )
            OR EXISTS (
              SELECT 1
              FROM source_connections_locked connection
              WHERE connection.id = source_input.user_source_connection_id
                AND connection.provider = 'google_drive'
                AND (source_input.status <> 'connected' OR connection.status = 'connected')
            )
          )
        )
    ),
    sources_written AS (
      INSERT INTO project_source_bindings (
        id, workspace_id, project_id, source_kind, domain_id,
        user_source_connection_id, source_ref, status, read_policy,
        connected_by, connected_at, last_verified_at,
        reconnect_required_reason, metadata, created_at, updated_at
      )
      SELECT
        source_eligibility.id, project_written.workspace_id, project_written.id,
        source_eligibility.source_kind, source_eligibility.domain_id,
        source_eligibility.user_source_connection_id, source_eligibility.source_ref,
        source_eligibility.status, source_eligibility.read_policy, source_eligibility.connected_by,
        source_eligibility.connected_at, source_eligibility.last_verified_at,
        source_eligibility.reconnect_required_reason, source_eligibility.metadata,
        source_eligibility.created_at, source_eligibility.updated_at
      FROM project_written
      CROSS JOIN source_eligibility
      RETURNING id, workspace_id, project_id, source_kind, domain_id,
                user_source_connection_id, source_ref, status, read_policy,
                connected_by, connected_at, last_verified_at,
                reconnect_required_reason, metadata, created_at, updated_at
    ),
    goal_rollup AS (
      SELECT CASE
        WHEN count(*) = 0 THEN NULL
        ELSE (jsonb_agg(to_jsonb(goal_written) ORDER BY goal_written.created_at, goal_written.id) -> 0)
      END AS initial_goal
      FROM goal_written
    ),
    source_rollup AS (
      SELECT
        count(*)::integer AS source_count,
        COALESCE(
          jsonb_agg(to_jsonb(sources_written) ORDER BY sources_written.created_at, sources_written.id),
          '[]'::jsonb
        ) AS source_bindings
      FROM sources_written
    ),
    event_written AS (
      INSERT INTO operation_events (
        id, workspace_id, project_id, source_tool, agent_id, status, summary,
        body, visibility, occurred_at, authorized_by_user_id, instrument_kind,
        authority_source, request_id
      )
      SELECT
        ${operationEventId}, project_written.workspace_id, project_written.id,
        'xlooop', ${actor}, 'completed', ('Project created: ' || project_written.name),
        'Project and initial framing persisted atomically.', 'internal_workspace',
        ${commandTimestamp}::timestamptz,
        ${actor}, 'human', 'role', ${idempotency.request_id ?? null}
      FROM project_written
      JOIN goal_rollup ON TRUE
      JOIN source_rollup ON source_rollup.source_count = ${expectedSourceCount}
      WHERE ${goalId}::text IS NULL OR goal_rollup.initial_goal IS NOT NULL
      RETURNING id, occurred_at
    ),
    audit_written AS (
      INSERT INTO audit_logs (
        id, actor_user_id, action, target_type, target_id, workspace_id, reason,
        causation_id, metadata
      )
      SELECT
        command_envelope.audit_id, ${actor}, 'project_create', 'project', project_written.id,
        project_written.workspace_id, 'project created with atomic initial framing',
        event_written.id,
        jsonb_build_object(
          'request_id', ${idempotency.request_id ?? null}::text,
          'request_sha256', ${idempotency.request_sha256}::text,
          'initial_goal_id', goal_rollup.initial_goal->>'id',
          'source_binding_count', source_rollup.source_count
        )
      FROM project_written
      JOIN goal_rollup ON TRUE
      JOIN source_rollup ON TRUE
      JOIN event_written ON TRUE
      JOIN command_envelope ON TRUE
      RETURNING id::text AS audit_event_id
    ),
    outbox_written AS (
      INSERT INTO projection_outbox (
        id, workspace_id, event_type, aggregate_type, aggregate_id, payload, created_at
      )
      SELECT
        ${projectionOutboxId}, project_written.workspace_id, 'project.created',
        'project', project_written.id,
        jsonb_build_object(
          'project_id', project_written.id,
          'initial_goal_id', goal_rollup.initial_goal->>'id',
          'source_binding_count', source_rollup.source_count,
          'operation_event_id', event_written.id,
          'audit_event_id', audit_written.audit_event_id,
          'request_sha256', ${idempotency.request_sha256}::text
        ),
        ${commandTimestamp}::timestamptz
      FROM project_written
      JOIN goal_rollup ON TRUE
      JOIN source_rollup ON TRUE
      JOIN event_written ON TRUE
      JOIN audit_written ON TRUE
      RETURNING id, created_at
    ),
    authority_result AS (
      SELECT
        strict_claim.response_body,
        xlooop_assert_authority_complete(
          (SELECT count(*) FROM project_written) = 1
          AND (SELECT count(*) FROM goal_written) = ${expectedGoalCount}
          AND (SELECT count(*) FROM sources_written) = ${expectedSourceCount}
          AND (SELECT count(*) FROM event_written) = 1
          AND (SELECT count(*) FROM audit_written) = 1
          AND (SELECT count(*) FROM outbox_written) = 1,
          'project_create'
        ) AS authority_complete
      FROM strict_claim
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
      return readStrictReplay(sql, input.workspace_id, actor, idempotency);
    }
    if (sqlError.code === '23514' && sqlError.message?.includes('xlooop authority incomplete')) {
      throw makeError('PROJECT_ATOMICITY_FAILED', 'project command did not complete every authority row', 500);
    }
    throw error;
  }

  if (rows[0]?.response_body) return receiptFromBody(rows[0].response_body, false);
  return readStrictReplay(sql, input.workspace_id, actor, idempotency);
}

export { mutateProjectWithAuthorityRow } from './project-mutation-store';
