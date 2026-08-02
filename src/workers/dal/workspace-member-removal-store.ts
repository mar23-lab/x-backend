import type {
  UserId,
  WorkspaceId,
  WorkspaceMemberMutationIdempotencyInput,
  WorkspaceMemberRemovalReceipt,
} from './types';
import type { Sql } from '../db/client';
import { assertWorkspaceScope } from './DalAdapter';
import { makeError, randomNanoid } from './shared-helpers';
import {
  cleanMemberMutationValue,
  findStrictMemberMutationReplay,
  memberMutationReceiptFromBody,
  readStrictMemberMutationReplay,
  validateMemberMutationIdempotency,
} from './workspace-member-authority-helpers';

// Soft-remove a member and revoke their effective workspace authority in one strict command.
export async function removeWorkspaceMemberRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  targetUserId: UserId,
  actorUserId: UserId,
  idempotency: WorkspaceMemberMutationIdempotencyInput,
): Promise<WorkspaceMemberRemovalReceipt> {
  assertWorkspaceScope(workspaceId);
  validateMemberMutationIdempotency(idempotency, 'DELETE /api/v1/members/:userId');

  const actor = cleanMemberMutationValue(actorUserId);
  const target = cleanMemberMutationValue(targetUserId);
  if (!actor || !target) throw makeError('VALIDATION_ERROR', 'actor and target member are required', 400);

  if (target === actor) {
    throw makeError('CANNOT_REMOVE_SELF', 'you cannot remove yourself from the workspace', 409);
  }

  const operationEventId = `evt_${randomNanoid()}`;
  const projectionOutboxId = `out_${randomNanoid()}`;
  const commandTimestamp = new Date().toISOString();
  let rows: Array<{ response_body: unknown }>;
  try {
    rows = (await sql/*sql*/`
      WITH existing_replay AS (
        SELECT id FROM idempotency_keys
        WHERE workspace_id = ${workspaceId}
          AND actor_user_id = ${actor}
          AND route = ${idempotency.route}
          AND idempotency_key = ${idempotency.key}
          AND mode = 'authority_strict'
        LIMIT 1
      ),
      command_envelope AS (
        SELECT nextval(pg_get_serial_sequence('audit_logs', 'id'))::bigint AS audit_id
        WHERE NOT EXISTS (SELECT 1 FROM existing_replay)
      ),
      target_snapshot AS MATERIALIZED (
        SELECT user_id, workspace_id, role
        FROM workspace_members
        WHERE workspace_id = ${workspaceId} AND user_id = ${target} AND removed_at IS NULL
        FOR UPDATE
      ),
      owner_snapshot AS MATERIALIZED (
        SELECT user_id FROM workspace_members
        WHERE workspace_id = ${workspaceId} AND role = 'owner' AND removed_at IS NULL
        FOR UPDATE
      ),
      command_guard AS (
        SELECT CASE
          WHEN (SELECT count(*) FROM target_snapshot) <> 1 THEN
            xlooop_assert_authority_complete(false, 'member_remove_target')
          WHEN (SELECT role FROM target_snapshot) = 'owner'
            AND (SELECT count(*) FROM owner_snapshot) <= 1 THEN
            xlooop_assert_authority_complete(false, 'member_remove_last_owner')
          ELSE true
        END AS complete
        FROM command_envelope
      ),
      member_removed AS (
        UPDATE workspace_members
        SET removed_at = ${commandTimestamp}::timestamptz
        FROM command_guard
        WHERE workspace_members.workspace_id = ${workspaceId}
          AND workspace_members.user_id = ${target}
          AND workspace_members.removed_at IS NULL
          AND command_guard.complete
        RETURNING workspace_members.user_id, workspace_members.workspace_id, workspace_members.removed_at
      ),
      entitlement_revoked AS (
        INSERT INTO customer_entitlements (
          id, user_id, workspace_id, app_id, account_type,
          allowed_modes, allowed_actions, denied_actions,
          authority_ref, granted_at, granted_by, created_at, updated_at
        )
        SELECT
          'cent_' || replace(gen_random_uuid()::text, '-', ''), member_removed.user_id,
          member_removed.workspace_id, 'xlooop-product', 'company',
          ARRAY['watch']::text[], ARRAY[]::text[], ARRAY['*']::text[],
          'membership:removed', ${commandTimestamp}::timestamptz, ${actor},
          ${commandTimestamp}::timestamptz, ${commandTimestamp}::timestamptz
        FROM member_removed
        ON CONFLICT (user_id, workspace_id, app_id) DO UPDATE SET
          allowed_modes = ARRAY['watch']::text[],
          allowed_actions = ARRAY[]::text[],
          denied_actions = ARRAY['*']::text[],
          authority_ref = 'membership:removed',
          granted_at = EXCLUDED.granted_at,
          granted_by = EXCLUDED.granted_by,
          updated_at = EXCLUDED.updated_at
        RETURNING user_id, workspace_id
      ),
      preference_downgraded AS (
        INSERT INTO user_session_preferences (user_id, workspace_id, operating_mode, updated_at)
        SELECT member_removed.user_id, member_removed.workspace_id, 'watch', ${commandTimestamp}::timestamptz
        FROM member_removed
        ON CONFLICT (user_id, workspace_id) DO UPDATE SET
          operating_mode = 'watch', updated_at = EXCLUDED.updated_at
        RETURNING user_id, workspace_id
      ),
      event_written AS (
        INSERT INTO operation_events (
          id, workspace_id, source_tool, agent_id, status, summary, body, visibility,
          occurred_at, authorized_by_user_id, instrument_kind, authority_source, request_id
        )
        SELECT ${operationEventId}, member_removed.workspace_id, 'xlooop', ${actor}, 'completed',
               'Workspace member removed',
               'Membership was revoked through an owner command; effective authority was downgraded.',
               'internal_workspace', ${commandTimestamp}::timestamptz, ${actor}, 'human', 'role',
               ${idempotency.request_id ?? null}
        FROM member_removed
        JOIN entitlement_revoked ON TRUE
        JOIN preference_downgraded ON TRUE
        RETURNING id, occurred_at
      ),
      audit_written AS (
        INSERT INTO audit_logs (
          id, actor_user_id, action, target_type, target_id, workspace_id, reason,
          causation_id, metadata
        )
        SELECT command_envelope.audit_id, ${actor}, 'member_removed', 'workspace_member',
               member_removed.user_id, member_removed.workspace_id, 'removed from workspace',
               event_written.id,
               jsonb_build_object(
                 'request_id', ${idempotency.request_id ?? null}::text,
                 'request_sha256', ${idempotency.request_sha256}::text
               )
        FROM member_removed
        JOIN event_written ON TRUE
        JOIN command_envelope ON TRUE
        RETURNING id::text AS audit_event_id
      ),
      outbox_written AS (
        INSERT INTO projection_outbox (
          id, workspace_id, event_type, aggregate_type, aggregate_id, payload, created_at
        )
        SELECT ${projectionOutboxId}, member_removed.workspace_id, 'workspace_member.removed',
               'workspace_member', member_removed.user_id,
               jsonb_build_object(
                 'user_id', member_removed.user_id,
                 'operation_event_id', event_written.id,
                 'audit_event_id', audit_written.audit_event_id,
                 'request_sha256', ${idempotency.request_sha256}::text
               ),
               ${commandTimestamp}::timestamptz
        FROM member_removed
        JOIN event_written ON TRUE
        JOIN audit_written ON TRUE
        RETURNING id, created_at
      ),
      strict_claim AS (
        INSERT INTO idempotency_keys (
          workspace_id, idempotency_key, route, actor_user_id, request_sha256, mode,
          response_status, response_body, completed_at
        )
        SELECT ${workspaceId}, ${idempotency.key}, ${idempotency.route}, ${actor},
               ${idempotency.request_sha256}, 'authority_strict', 200,
               jsonb_build_object(
                 'removed', jsonb_build_object(
                   'user_id', member_removed.user_id,
                   'workspace_id', member_removed.workspace_id,
                   'removed_at', member_removed.removed_at
                 ),
                 'member_mutation_receipt_id',
                   ('workspace-member:' || member_removed.workspace_id || ':' || member_removed.user_id
                     || ':remove:' || audit_written.audit_event_id),
                 'operation_event_id', event_written.id,
                 'audit_event_id', audit_written.audit_event_id,
                 'projection_outbox_id', outbox_written.id,
                 'read_model_watermark', ${commandTimestamp}::text,
                 'replayed', false
               ),
               ${commandTimestamp}::timestamptz
        FROM member_removed
        JOIN entitlement_revoked ON TRUE
        JOIN preference_downgraded ON TRUE
        JOIN event_written ON TRUE
        JOIN audit_written ON TRUE
        JOIN outbox_written ON TRUE
        RETURNING response_body
      ),
      authority_result AS (
        SELECT strict_claim.response_body,
               CASE
                 WHEN (SELECT count(*) FROM target_snapshot) <> 1 THEN
                   xlooop_assert_authority_complete(false, 'member_remove_target')
                 WHEN (SELECT role FROM target_snapshot) = 'owner'
                   AND (SELECT count(*) FROM owner_snapshot) <= 1 THEN
                   xlooop_assert_authority_complete(false, 'member_remove_last_owner')
                 ELSE xlooop_assert_authority_complete(
                   (SELECT count(*) FROM member_removed) = 1
                   AND (SELECT count(*) FROM entitlement_revoked) = 1
                   AND (SELECT count(*) FROM preference_downgraded) = 1
                   AND (SELECT count(*) FROM event_written) = 1
                   AND (SELECT count(*) FROM audit_written) = 1
                   AND (SELECT count(*) FROM outbox_written) = 1
                   AND (SELECT count(*) FROM strict_claim) = 1,
                   'member_remove_mutation'
                 )
               END AS authority_complete
        FROM command_envelope
        LEFT JOIN strict_claim ON TRUE
      )
      SELECT response_body FROM authority_result WHERE authority_complete
    `) as Array<{ response_body: unknown }>;
  } catch (error) {
    const sqlError = error as { code?: string; constraint?: string; message?: string };
    if (sqlError.code === '23505' && (sqlError.constraint === 'idempotency_keys_authority_key'
      || sqlError.message?.includes('idempotency_keys_authority_key'))) {
      return readStrictMemberMutationReplay(sql, workspaceId, actor, idempotency, 'remove') as Promise<WorkspaceMemberRemovalReceipt>;
    }
    if (sqlError.code === '23514' && sqlError.message?.includes('member_remove_target')) {
      // A concurrent exact retry may take its statement snapshot before the winning
      // command commits, then observe the winner's soft-delete after waiting on the
      // row lock. Re-read the durable replay under a fresh snapshot before calling
      // that outcome NOT_FOUND.
      const replay = await findStrictMemberMutationReplay(sql, workspaceId, actor, idempotency, 'remove');
      if (replay) return replay as WorkspaceMemberRemovalReceipt;
      throw makeError('NOT_FOUND', `member ${target} not in workspace ${workspaceId}`, 404);
    }
    if (sqlError.code === '23514' && sqlError.message?.includes('member_remove_last_owner')) {
      throw makeError('LAST_OWNER', 'cannot remove the last remaining owner', 409);
    }
    if (sqlError.code === '23514' && sqlError.message?.includes('xlooop authority incomplete')) {
      throw makeError('MEMBER_ATOMICITY_FAILED', 'member removal did not complete every authority row', 500);
    }
    throw error;
  }
  if (rows[0]?.response_body) {
    return memberMutationReceiptFromBody(rows[0].response_body, 'remove', false) as WorkspaceMemberRemovalReceipt;
  }
  return readStrictMemberMutationReplay(sql, workspaceId, actor, idempotency, 'remove') as Promise<WorkspaceMemberRemovalReceipt>;
}
