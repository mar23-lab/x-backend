import { Client, type QueryConfig } from 'pg';
import { describe, expect, it } from 'vitest';
import { createProjectWithAuthorityRow } from '../dal/project-command-store';
import type { ProjectCreateAuthorityInput, ProjectCreateIdempotencyInput } from '../dal/types';
import type { Sql } from '../db/client';

type DeferredQuery = QueryConfig<unknown[]>;

function postgresSql(client: Client): Sql {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]): DeferredQuery => {
    let text = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    const query = { text, values } as DeferredQuery & PromiseLike<unknown[]>;
    Object.defineProperty(query, 'then', {
      enumerable: false,
      value: (
        resolve: (rows: unknown[]) => unknown,
        reject: (error: unknown) => unknown,
      ) => client.query(query).then((result) => resolve(result.rows), reject),
    });
    return query;
  }) as unknown as Sql;

  return tag;
}

const databaseUrl = process.env.XLOOOP_SCHEMA93_PG_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('schema 93 strict project authority', () => {
  it('persists one complete command, replays exactly, and rolls back incomplete authority', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    const suffix = crypto.randomUUID().replaceAll('-', '');
    const workspaceId = `ws_project_pg93_${suffix}`;
    const userId = `user_project_pg93_${suffix}`;
    const projectId = `proj_project_pg93_${suffix}`;
    const missingParentProjectId = `proj_missing_parent_pg93_${suffix}`;
    const missingParentChildId = `proj_missing_parent_child_pg93_${suffix}`;
    const rollbackProjectId = `proj_rollback_pg93_${suffix}`;
    const request = {
      key: `project_pg93_${suffix}`,
      request_sha256: 'a'.repeat(64),
      route: 'POST /api/v1/projects',
      request_id: `request_pg93_${suffix}`,
    } satisfies ProjectCreateIdempotencyInput;
    const input = {
      id: projectId,
      workspace_id: workspaceId,
      name: 'Atomic project framing',
      description: 'One project command with a goal and admitted source.',
      initial_goal: {
        title: 'Prove atomic project framing',
        summary: 'No partial project, framing, or authority rows.',
        target_date: '2026-12-31',
      },
      source_bindings: [{
        source_kind: 'manual',
        source_ref: { uri: `manual://project/${projectId}` },
        status: 'connected',
        read_policy: 'read_only',
        metadata: { admitted: true },
      }],
    } satisfies ProjectCreateAuthorityInput;

    try {
      await client.query(
        `INSERT INTO users (id, email, status, approved_at)
         VALUES ($1, $2, 'approved', now())`,
        [userId, `${suffix}@example.test`],
      );
      await client.query(
        `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, relationship_status)
         VALUES ($1, 'Project schema 93 integration', $2, 'company', 'internal_dogfood')`,
        [workspaceId, userId],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at)
         VALUES ($1, $2, 'owner', 'active', now())`,
        [workspaceId, userId],
      );

      const sql = postgresSql(client);
      let created;
      try {
        created = await createProjectWithAuthorityRow(sql, input, userId, request);
      } catch (error) {
        const diagnostic = await client.query(
          `SELECT
             (SELECT count(*)::integer FROM projects WHERE id = $1) AS project_count,
             (SELECT count(*)::integer FROM plan_entities WHERE scope_id = $1) AS plan_count,
             (SELECT count(*)::integer FROM project_source_bindings WHERE project_id = $1) AS source_count,
             (SELECT count(*)::integer FROM operation_events WHERE project_id = $1) AS event_count,
             (SELECT count(*)::integer FROM audit_logs WHERE target_type = 'project' AND target_id = $1) AS audit_count,
             (SELECT count(*)::integer FROM projection_outbox WHERE aggregate_type = 'project' AND aggregate_id = $1) AS outbox_count,
             (SELECT count(*)::integer FROM idempotency_keys WHERE workspace_id = $2 AND idempotency_key = $3) AS replay_count`,
          [projectId, workspaceId, request.key],
        );
        throw new Error(
          `strict project authority failed at ${JSON.stringify(diagnostic.rows[0])}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      expect(created).toMatchObject({
        replayed: false,
        project: { id: projectId, workspace_id: workspaceId, name: input.name },
        initial_goal: { title: input.initial_goal.title, scope_id: projectId },
        source_bindings: [{ project_id: projectId, source_kind: 'manual' }],
      });
      expect(created.receipt_id).toContain(projectId);
      expect(created.operation_event_id).toBeTruthy();
      expect(created.audit_event_id).toBeTruthy();
      expect(created.projection_outbox_id).toBeTruthy();
      expect(created.read_model_watermark).toBeTruthy();

      const replay = await createProjectWithAuthorityRow(sql, input, userId, request);
      expect(replay).toEqual({ ...created, replayed: true });

      await expect(createProjectWithAuthorityRow(sql, input, userId, {
        ...request,
        request_sha256: 'b'.repeat(64),
      })).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
        status: 409,
      });

      const authority = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM projects WHERE id = $1) AS project_count,
           (SELECT count(*)::integer FROM plan_entities WHERE scope_id = $1 AND kind = 'goal') AS goal_count,
           (SELECT count(*)::integer FROM project_source_bindings WHERE project_id = $1) AS source_count,
           (SELECT count(*)::integer FROM operation_events WHERE project_id = $1) AS event_count,
           (SELECT count(*)::integer FROM audit_logs WHERE target_type = 'project' AND target_id = $1) AS audit_count,
           (SELECT count(*)::integer FROM projection_outbox WHERE aggregate_type = 'project' AND aggregate_id = $1) AS outbox_count,
           (SELECT count(*)::integer FROM idempotency_keys
             WHERE workspace_id = $2 AND actor_user_id = $3 AND route = $4
               AND idempotency_key = $5 AND mode = 'authority_strict'
               AND response_status = 201 AND response_body IS NOT NULL) AS replay_count`,
        [projectId, workspaceId, userId, request.route, request.key],
      );
      expect(authority.rows[0]).toEqual({
        project_count: 1,
        goal_count: 1,
        source_count: 1,
        event_count: 1,
        audit_count: 1,
        outbox_count: 1,
        replay_count: 1,
      });

      const missingParentRequest = {
        ...request,
        key: `project_missing_parent_pg93_${suffix}`,
        request_sha256: 'c'.repeat(64),
      };
      await expect(createProjectWithAuthorityRow(sql, {
        id: missingParentChildId,
        workspace_id: workspaceId,
        name: 'Must not exist without its parent',
        parent_project_id: missingParentProjectId,
      }, userId, missingParentRequest)).rejects.toMatchObject({
        code: 'PROJECT_ATOMICITY_FAILED',
        status: 500,
      });

      const rollbackRequest = {
        ...request,
        key: `project_rollback_pg93_${suffix}`,
        request_sha256: 'd'.repeat(64),
      };
      await expect(createProjectWithAuthorityRow(sql, {
        id: rollbackProjectId,
        workspace_id: workspaceId,
        name: 'Must roll back downstream failure',
        initial_goal: { title: 'Must also roll back' },
        source_bindings: [
          { source_kind: 'manual', source_ref: { uri: 'manual://duplicate' } },
          { source_kind: 'manual', source_ref: { uri: 'manual://duplicate' } },
        ],
      }, userId, rollbackRequest)).rejects.toThrow(/uq_project_source_bindings_active_ref|duplicate key/i);

      const absentAuthority = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM projects WHERE id = ANY($1::text[])) AS project_count,
           (SELECT count(*)::integer FROM plan_entities WHERE scope_id = ANY($1::text[])) AS plan_count,
           (SELECT count(*)::integer FROM project_source_bindings WHERE project_id = ANY($1::text[])) AS source_count,
           (SELECT count(*)::integer FROM operation_events WHERE project_id = ANY($1::text[])) AS event_count,
           (SELECT count(*)::integer FROM audit_logs WHERE target_type = 'project' AND target_id = ANY($1::text[])) AS audit_count,
           (SELECT count(*)::integer FROM projection_outbox WHERE aggregate_type = 'project' AND aggregate_id = ANY($1::text[])) AS outbox_count,
           (SELECT count(*)::integer FROM idempotency_keys
             WHERE workspace_id = $2 AND idempotency_key = ANY($3::text[])) AS replay_count`,
        [
          [missingParentChildId, rollbackProjectId],
          workspaceId,
          [missingParentRequest.key, rollbackRequest.key],
        ],
      );
      expect(absentAuthority.rows[0]).toEqual({
        project_count: 0,
        plan_count: 0,
        source_count: 0,
        event_count: 0,
        audit_count: 0,
        outbox_count: 0,
        replay_count: 0,
      });
    } finally {
      await client.query('DELETE FROM audit_logs WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM operation_events WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM projection_outbox WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM idempotency_keys WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM project_source_bindings WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM plan_entities WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM projects WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM access_requests WHERE invited_to_workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.end();
    }
  });

  it('serializes concurrent exact requests into one project and one replay result', async () => {
    const setup = new Client({ connectionString: databaseUrl });
    const firstClient = new Client({ connectionString: databaseUrl });
    const secondClient = new Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), firstClient.connect(), secondClient.connect()]);

    const suffix = crypto.randomUUID().replaceAll('-', '');
    const workspaceId = `ws_project_concurrent_pg93_${suffix}`;
    const userId = `user_project_concurrent_pg93_${suffix}`;
    const request = {
      key: `project_concurrent_pg93_${suffix}`,
      request_sha256: 'e'.repeat(64),
      route: 'POST /api/v1/projects',
      request_id: `request_concurrent_pg93_${suffix}`,
    } satisfies ProjectCreateIdempotencyInput;
    const input = {
      workspace_id: workspaceId,
      name: 'Concurrent exact project command',
      initial_goal: { title: 'Converge on one durable result' },
    } satisfies ProjectCreateAuthorityInput;

    try {
      await setup.query(
        `INSERT INTO users (id, email, status, approved_at)
         VALUES ($1, $2, 'approved', now())`,
        [userId, `${suffix}@example.test`],
      );
      await setup.query(
        `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, relationship_status)
         VALUES ($1, 'Concurrent schema 93 integration', $2, 'company', 'internal_dogfood')`,
        [workspaceId, userId],
      );
      await setup.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at)
         VALUES ($1, $2, 'owner', 'active', now())`,
        [workspaceId, userId],
      );

      const [first, second] = await Promise.all([
        createProjectWithAuthorityRow(postgresSql(firstClient), input, userId, request),
        createProjectWithAuthorityRow(postgresSql(secondClient), input, userId, request),
      ]);
      const original = first.replayed ? second : first;
      const replay = first.replayed ? first : second;

      expect(original.replayed).toBe(false);
      expect(replay).toEqual({ ...original, replayed: true });

      const authority = await setup.query(
        `SELECT
           (SELECT count(*)::integer FROM projects WHERE workspace_id = $1) AS project_count,
           (SELECT count(*)::integer FROM plan_entities WHERE workspace_id = $1 AND kind = 'goal') AS goal_count,
           (SELECT count(*)::integer FROM operation_events WHERE workspace_id = $1) AS event_count,
           (SELECT count(*)::integer FROM audit_logs WHERE workspace_id = $1 AND action = 'project_create') AS audit_count,
           (SELECT count(*)::integer FROM projection_outbox WHERE workspace_id = $1 AND event_type = 'project.created') AS outbox_count,
           (SELECT count(*)::integer FROM idempotency_keys
             WHERE workspace_id = $1 AND idempotency_key = $2 AND mode = 'authority_strict') AS replay_count`,
        [workspaceId, request.key],
      );
      expect(authority.rows[0]).toEqual({
        project_count: 1,
        goal_count: 1,
        event_count: 1,
        audit_count: 1,
        outbox_count: 1,
        replay_count: 1,
      });
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
      await setup.query('DELETE FROM audit_logs WHERE workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM operation_events WHERE workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM projection_outbox WHERE workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM idempotency_keys WHERE workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM project_source_bindings WHERE workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM plan_entities WHERE workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM projects WHERE workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM access_requests WHERE invited_to_workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await setup.query('DELETE FROM users WHERE id = $1', [userId]);
      await setup.end();
    }
  });
});
