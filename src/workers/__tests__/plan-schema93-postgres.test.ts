import { Client, type QueryConfig } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Sql } from '../db/client';
import {
  commandTargetFromEntity,
  createPlanEntityWithAuthorityRow,
  deletePlanEntityWithAuthorityRow,
  updatePlanEntityWithAuthorityRow,
} from '../dal/plan-command-operations';

type DeferredQuery = QueryConfig<unknown[]>;

function postgresSql(client: Client): Sql {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? '';
    values.forEach((_, index) => { text += `$${index + 1}${strings[index + 1] ?? ''}`; });
    const query = { text, values } as DeferredQuery & PromiseLike<unknown[]>;
    Object.defineProperty(query, 'then', {
      enumerable: false,
      value: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        client.query(query).then((result) => resolve(result.rows), reject),
    });
    return query;
  }) as unknown as Sql & { transaction: (queries: readonly DeferredQuery[]) => Promise<unknown[][]> };
  tag.transaction = async (queries) => {
    await client.query('BEGIN');
    try {
      const results: unknown[][] = [];
      for (const query of queries) results.push((await client.query(query)).rows);
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };
  return tag;
}

const databaseUrl = process.env.XLOOOP_SCHEMA93_PG_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('schema 93 plan authority commands', () => {
  it('creates, replays, reorders, deletes, and records complete authority atomically', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const userId = `user_plan93_${suffix}`;
    const workspaceId = `ws_plan93_${suffix}`;
    const projectId = `proj_plan93_${suffix}`;
    const sql = postgresSql(client);
    try {
      await client.query(
        `INSERT INTO users (id, email, status, approved_at) VALUES ($1, $2, 'approved', now())`,
        [userId, `${suffix}@example.test`],
      );
      await client.query(
        `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, relationship_status)
         VALUES ($1, 'Plan authority integration', $2, 'company', 'internal_dogfood')`,
        [workspaceId, userId],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at)
         VALUES ($1, $2, 'owner', 'active', now())`,
        [workspaceId, userId],
      );
      await client.query(
        `INSERT INTO projects (id, workspace_id, name, status) VALUES ($1, $2, 'Plan project', 'active')`,
        [projectId, workspaceId],
      );

      const firstDigest = 'a'.repeat(64);
      const first = await createPlanEntityWithAuthorityRow(
        sql,
        { workspace_id: workspaceId, scope_id: projectId, scope_type: 'project', kind: 'goal', title: 'First goal' },
        userId,
        { key: `plan-create-first-${suffix}`, request_sha256: firstDigest, route: 'POST /api/v1/plan/entity' },
      );
      expect(first.replayed).toBe(false);
      expect(first.entity).toMatchObject({ title: 'First goal', position: 0 });
      expect(first.receipt_id).toBeTruthy();
      const replay = await createPlanEntityWithAuthorityRow(
        sql,
        { workspace_id: workspaceId, scope_id: projectId, scope_type: 'project', kind: 'goal', title: 'First goal' },
        userId,
        { key: `plan-create-first-${suffix}`, request_sha256: firstDigest, route: 'POST /api/v1/plan/entity' },
      );
      expect(replay).toEqual({ ...first, replayed: true });

      const second = await createPlanEntityWithAuthorityRow(
        sql,
        { workspace_id: workspaceId, scope_id: projectId, scope_type: 'project', kind: 'goal', title: 'Second goal' },
        userId,
        { key: `plan-create-second-${suffix}`, request_sha256: 'b'.repeat(64), route: 'POST /api/v1/plan/entity' },
      );
      expect(second.entity?.position).toBe(1);

      const child = await createPlanEntityWithAuthorityRow(
        sql,
        {
          workspace_id: workspaceId,
          scope_id: projectId,
          scope_type: 'project',
          parent_id: first.plan_entity_id,
          kind: 'milestone',
          title: 'Child milestone',
        },
        userId,
        { key: `plan-create-child-${suffix}`, request_sha256: 'e'.repeat(64), route: 'POST /api/v1/plan/entity' },
      );
      const authorityBeforeCycle = await client.query(
        `SELECT
          (SELECT count(*)::int FROM plan_entities WHERE workspace_id = $1) AS entities,
          (SELECT count(*)::int FROM operation_events WHERE workspace_id = $1) AS events,
          (SELECT count(*)::int FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'plan_entity_%') AS audits,
          (SELECT count(*)::int FROM projection_outbox WHERE workspace_id = $1 AND aggregate_type = 'plan_entity') AS outbox,
          (SELECT count(*)::int FROM idempotency_keys WHERE workspace_id = $1 AND mode = 'authority_strict') AS replays`,
        [workspaceId],
      );
      await expect(updatePlanEntityWithAuthorityRow(
        sql,
        commandTargetFromEntity(first.entity!),
        { parent_id: child.plan_entity_id },
        userId,
        {
          key: `plan-cycle-${suffix}`,
          request_sha256: 'f'.repeat(64),
          route: `PATCH /api/v1/plan/entity/${first.plan_entity_id}`,
        },
      )).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
      const authorityAfterCycle = await client.query(
        `SELECT
          (SELECT count(*)::int FROM plan_entities WHERE workspace_id = $1) AS entities,
          (SELECT count(*)::int FROM operation_events WHERE workspace_id = $1) AS events,
          (SELECT count(*)::int FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'plan_entity_%') AS audits,
          (SELECT count(*)::int FROM projection_outbox WHERE workspace_id = $1 AND aggregate_type = 'plan_entity') AS outbox,
          (SELECT count(*)::int FROM idempotency_keys WHERE workspace_id = $1 AND mode = 'authority_strict') AS replays`,
        [workspaceId],
      );
      expect(authorityAfterCycle.rows[0]).toEqual(authorityBeforeCycle.rows[0]);

      const updated = await updatePlanEntityWithAuthorityRow(
        sql,
        commandTargetFromEntity(second.entity!),
        { title: 'Second goal first', position: 0 },
        userId,
        {
          key: `plan-update-${suffix}`,
          request_sha256: 'c'.repeat(64),
          route: `PATCH /api/v1/plan/entity/${second.plan_entity_id}`,
        },
      );
      expect(updated.entity).toMatchObject({ title: 'Second goal first', position: 0 });
      const ordered = await client.query(
        `SELECT id, position FROM plan_entities
         WHERE workspace_id = $1 AND scope_id = $2 AND parent_id IS NULL
           AND deleted_at IS NULL ORDER BY position`,
        [workspaceId, projectId],
      );
      expect(ordered.rows).toEqual([
        { id: second.plan_entity_id, position: 0 },
        { id: first.plan_entity_id, position: 1 },
      ]);

      const deleted = await deletePlanEntityWithAuthorityRow(
        sql,
        commandTargetFromEntity(updated.entity!),
        userId,
        {
          key: `plan-delete-${suffix}`,
          request_sha256: 'd'.repeat(64),
          route: `DELETE /api/v1/plan/entity/${second.plan_entity_id}`,
        },
      );
      expect(deleted.deleted?.id).toBe(second.plan_entity_id);
      const counts = await client.query(
        `SELECT
          (SELECT count(*)::int FROM plan_entities WHERE workspace_id = $1 AND deleted_at IS NULL) AS active,
          (SELECT count(*)::int FROM operation_events WHERE workspace_id = $1) AS events,
          (SELECT count(*)::int FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'plan_entity_%') AS audits,
          (SELECT count(*)::int FROM projection_outbox WHERE workspace_id = $1 AND aggregate_type = 'plan_entity') AS outbox,
          (SELECT count(*)::int FROM idempotency_keys WHERE workspace_id = $1 AND mode = 'authority_strict') AS replays`,
        [workspaceId],
      );
      expect(counts.rows[0]).toEqual({ active: 2, events: 5, audits: 5, outbox: 5, replays: 5 });
    } finally {
      await client.query('DELETE FROM audit_logs WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM operation_events WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM projection_outbox WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM idempotency_keys WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM plan_entities WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM projects WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM access_requests WHERE invited_to_workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM workspace_members WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.end();
    }
  });
});
