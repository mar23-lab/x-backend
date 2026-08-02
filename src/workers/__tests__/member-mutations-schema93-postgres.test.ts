import { Client, type QueryConfig } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Sql } from '../db/client';
import { removeWorkspaceMemberRow, setWorkspaceMemberRoleRow } from '../dal/workspace-member-store';
import type { WorkspaceMemberMutationIdempotencyInput } from '../dal/types';

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

describePostgres('schema 93 strict member authority', () => {
  it('persists role and removal authority exactly once and revokes effective access', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const workspaceId = `ws_member_pg93_${suffix}`;
    const ownerId = `owner_member_pg93_${suffix}`;
    const targetId = `target_member_pg93_${suffix}`;
    const missingId = `missing_member_pg93_${suffix}`;
    const roleRequest = {
      key: `member_role_pg93_${suffix}`,
      request_sha256: 'a'.repeat(64),
      route: 'PATCH /api/v1/members/:userId/role',
      request_id: `request_member_role_${suffix}`,
    } satisfies WorkspaceMemberMutationIdempotencyInput;
    const removeRequest = {
      key: `member_remove_pg93_${suffix}`,
      request_sha256: 'b'.repeat(64),
      route: 'DELETE /api/v1/members/:userId',
      request_id: `request_member_remove_${suffix}`,
    } satisfies WorkspaceMemberMutationIdempotencyInput;

    try {
      await client.query(
        `INSERT INTO users (id, email, status, approved_at)
         VALUES ($1, $2, 'approved', now()), ($3, $4, 'approved', now())`,
        [ownerId, `${ownerId}@example.test`, targetId, `${targetId}@example.test`],
      );
      await client.query(
        `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, relationship_status)
         VALUES ($1, 'Member schema 93 integration', $2, 'company', 'internal_dogfood')`,
        [workspaceId, ownerId],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at)
         VALUES ($1, $2, 'owner', 'active', now()), ($1, $3, 'operator', 'active', now())`,
        [workspaceId, ownerId, targetId],
      );

      const sql = postgresSql(client);
      const changed = await setWorkspaceMemberRoleRow(
        sql, workspaceId, targetId, 'viewer', ownerId, roleRequest,
      );
      expect(changed).toMatchObject({
        replayed: false,
        member: { user_id: targetId, workspace_id: workspaceId, role: 'viewer' },
      });
      expect(changed.member_mutation_receipt_id).toContain(targetId);
      expect(changed.operation_event_id).toBeTruthy();
      expect(changed.audit_event_id).toBeTruthy();
      expect(changed.projection_outbox_id).toBeTruthy();
      expect(changed.read_model_watermark).toBeTruthy();

      const roleReplay = await setWorkspaceMemberRoleRow(
        sql, workspaceId, targetId, 'viewer', ownerId, roleRequest,
      );
      expect(roleReplay).toEqual({ ...changed, replayed: true });
      await expect(setWorkspaceMemberRoleRow(sql, workspaceId, targetId, 'viewer', ownerId, {
        ...roleRequest,
        request_sha256: 'c'.repeat(64),
      })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

      const roleAuthority = await client.query(
        `SELECT
           (SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2) AS role,
           (SELECT allowed_modes FROM customer_entitlements
             WHERE workspace_id = $1 AND user_id = $2 AND app_id = 'xlooop-product') AS allowed_modes,
           (SELECT allowed_actions FROM customer_entitlements
             WHERE workspace_id = $1 AND user_id = $2 AND app_id = 'xlooop-product') AS allowed_actions,
           (SELECT operating_mode FROM user_session_preferences
             WHERE workspace_id = $1 AND user_id = $2) AS operating_mode,
           (SELECT count(*)::integer FROM operation_events
             WHERE workspace_id = $1 AND id = $3) AS event_count,
           (SELECT count(*)::integer FROM audit_logs
             WHERE workspace_id = $1 AND action = 'member_role_change' AND target_id = $2) AS audit_count,
           (SELECT count(*)::integer FROM projection_outbox
             WHERE workspace_id = $1 AND event_type = 'workspace_member.role_changed' AND aggregate_id = $2) AS outbox_count,
           (SELECT count(*)::integer FROM idempotency_keys
             WHERE workspace_id = $1 AND actor_user_id = $4 AND route = $5
               AND idempotency_key = $6 AND mode = 'authority_strict') AS replay_count`,
        [workspaceId, targetId, changed.operation_event_id, ownerId, roleRequest.route, roleRequest.key],
      );
      expect(roleAuthority.rows[0]).toEqual({
        role: 'viewer',
        allowed_modes: ['watch'],
        allowed_actions: [],
        operating_mode: 'watch',
        event_count: 1,
        audit_count: 1,
        outbox_count: 1,
        replay_count: 1,
      });

      const removed = await removeWorkspaceMemberRow(sql, workspaceId, targetId, ownerId, removeRequest);
      expect(removed).toMatchObject({
        replayed: false,
        removed: { user_id: targetId, workspace_id: workspaceId },
      });
      expect(removed.operation_event_id).toBeTruthy();
      expect(removed.audit_event_id).toBeTruthy();
      expect(removed.projection_outbox_id).toBeTruthy();
      expect(removed.read_model_watermark).toBeTruthy();

      const removeReplay = await removeWorkspaceMemberRow(sql, workspaceId, targetId, ownerId, removeRequest);
      expect(removeReplay).toEqual({ ...removed, replayed: true });
      await expect(removeWorkspaceMemberRow(sql, workspaceId, targetId, ownerId, {
        ...removeRequest,
        request_sha256: 'd'.repeat(64),
      })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

      const removalAuthority = await client.query(
        `SELECT
           (SELECT removed_at IS NOT NULL FROM workspace_members
             WHERE workspace_id = $1 AND user_id = $2) AS removed,
           (SELECT denied_actions FROM customer_entitlements
             WHERE workspace_id = $1 AND user_id = $2 AND app_id = 'xlooop-product') AS denied_actions,
           (SELECT operating_mode FROM user_session_preferences
             WHERE workspace_id = $1 AND user_id = $2) AS operating_mode,
           (SELECT count(*)::integer FROM operation_events
             WHERE workspace_id = $1 AND id = $3) AS event_count,
           (SELECT count(*)::integer FROM audit_logs
             WHERE workspace_id = $1 AND action = 'member_removed' AND target_id = $2) AS audit_count,
           (SELECT count(*)::integer FROM projection_outbox
             WHERE workspace_id = $1 AND event_type = 'workspace_member.removed' AND aggregate_id = $2) AS outbox_count,
           (SELECT count(*)::integer FROM idempotency_keys
             WHERE workspace_id = $1 AND actor_user_id = $4 AND route = $5
               AND idempotency_key = $6 AND mode = 'authority_strict') AS replay_count`,
        [workspaceId, targetId, removed.operation_event_id, ownerId, removeRequest.route, removeRequest.key],
      );
      expect(removalAuthority.rows[0]).toEqual({
        removed: true,
        denied_actions: ['*'],
        operating_mode: 'watch',
        event_count: 1,
        audit_count: 1,
        outbox_count: 1,
        replay_count: 1,
      });

      await expect(setWorkspaceMemberRoleRow(sql, workspaceId, missingId, 'viewer', ownerId, {
        ...roleRequest,
        key: `missing_role_${suffix}`,
        request_sha256: 'e'.repeat(64),
      })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(removeWorkspaceMemberRow(sql, workspaceId, missingId, ownerId, {
        ...removeRequest,
        key: `missing_remove_${suffix}`,
        request_sha256: 'f'.repeat(64),
      })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(setWorkspaceMemberRoleRow(sql, workspaceId, ownerId, 'viewer', targetId, {
        ...roleRequest,
        key: `last_owner_${suffix}`,
        request_sha256: '9'.repeat(64),
      })).rejects.toMatchObject({ code: 'LAST_OWNER', status: 409 });

      const failedAuthority = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM operation_events
             WHERE workspace_id = $1 AND authorized_by_user_id = $2
               AND summary LIKE 'Workspace member%') AS event_count,
           (SELECT count(*)::integer FROM idempotency_keys
             WHERE workspace_id = $1 AND idempotency_key = ANY($3::text[])) AS replay_count`,
        [workspaceId, targetId, [`missing_role_${suffix}`, `missing_remove_${suffix}`, `last_owner_${suffix}`]],
      );
      expect(failedAuthority.rows[0]).toEqual({ event_count: 0, replay_count: 0 });
    } finally {
      await client.query('DELETE FROM audit_logs WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM operation_events WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM projection_outbox WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM idempotency_keys WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM customer_entitlements WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM user_session_preferences WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM access_requests WHERE invited_to_workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, targetId]]);
      await client.end();
    }
  });

  it('serializes concurrent exact removals into one authority result and one replay', async () => {
    const setup = new Client({ connectionString: databaseUrl });
    const firstClient = new Client({ connectionString: databaseUrl });
    const secondClient = new Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), firstClient.connect(), secondClient.connect()]);

    const suffix = crypto.randomUUID().replaceAll('-', '');
    const workspaceId = `ws_member_concurrent_pg93_${suffix}`;
    const ownerId = `owner_member_concurrent_pg93_${suffix}`;
    const targetId = `target_member_concurrent_pg93_${suffix}`;
    const request = {
      key: `member_remove_concurrent_pg93_${suffix}`,
      request_sha256: '7'.repeat(64),
      route: 'DELETE /api/v1/members/:userId',
      request_id: `request_member_remove_concurrent_${suffix}`,
    } satisfies WorkspaceMemberMutationIdempotencyInput;

    try {
      await setup.query(
        `INSERT INTO users (id, email, status, approved_at)
         VALUES ($1, $2, 'approved', now()), ($3, $4, 'approved', now())`,
        [ownerId, `${ownerId}@example.test`, targetId, `${targetId}@example.test`],
      );
      await setup.query(
        `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, relationship_status)
         VALUES ($1, 'Concurrent member schema 93 integration', $2, 'company', 'internal_dogfood')`,
        [workspaceId, ownerId],
      );
      await setup.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at)
         VALUES ($1, $2, 'owner', 'active', now()), ($1, $3, 'viewer', 'active', now())`,
        [workspaceId, ownerId, targetId],
      );

      const [first, second] = await Promise.all([
        removeWorkspaceMemberRow(postgresSql(firstClient), workspaceId, targetId, ownerId, request),
        removeWorkspaceMemberRow(postgresSql(secondClient), workspaceId, targetId, ownerId, request),
      ]);
      const original = first.replayed ? second : first;
      const replay = first.replayed ? first : second;

      expect(original.replayed).toBe(false);
      expect(replay).toEqual({ ...original, replayed: true });

      const authority = await setup.query(
        `SELECT
           (SELECT count(*)::integer FROM workspace_members
             WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NOT NULL) AS removed_count,
           (SELECT count(*)::integer FROM operation_events
             WHERE workspace_id = $1 AND id = $3) AS event_count,
           (SELECT count(*)::integer FROM audit_logs
             WHERE workspace_id = $1 AND action = 'member_removed' AND target_id = $2) AS audit_count,
           (SELECT count(*)::integer FROM projection_outbox
             WHERE workspace_id = $1 AND event_type = 'workspace_member.removed' AND aggregate_id = $2) AS outbox_count,
           (SELECT count(*)::integer FROM idempotency_keys
             WHERE workspace_id = $1 AND actor_user_id = $4 AND route = $5
               AND idempotency_key = $6 AND mode = 'authority_strict') AS replay_count`,
        [workspaceId, targetId, original.operation_event_id, ownerId, request.route, request.key],
      );
      expect(authority.rows[0]).toEqual({
        removed_count: 1,
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
      await setup.query('DELETE FROM customer_entitlements WHERE workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM user_session_preferences WHERE workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM access_requests WHERE invited_to_workspace_id = $1', [workspaceId]);
      await setup.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await setup.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, targetId]]);
      await setup.end();
    }
  });
});
