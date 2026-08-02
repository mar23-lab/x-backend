// workspace-member-store.ts · Stage 3 · real workspace-member enumeration.
//
// Lists the REAL members of a workspace from the Neon `workspace_members` table
// (the accepted-membership source of truth — Clerk owns the invite lifecycle, the
// DB owns members who accepted an invite + signed in). LEFT JOIN `users` for each
// member's email + account status; both are null when the member has no Neon
// `users` row yet (Clerk is the identity source-of-record). Read-only +
// TENANT-SCOPED: assertWorkspaceScope() rejects an empty/null workspace_id (the
// multi-tenant DAL invariant — DalAdapter.ts CONTRACT INVARIANTS 1-3) and the WHERE
// clause confines the query to the passed workspace, so a caller can never
// enumerate another tenant's members.

import type { UserId, WorkspaceId, WorkspaceMember, WorkspaceMemberMutationIdempotencyInput, WorkspaceMemberRole, WorkspaceMemberRoleMutationReceipt } from './types';
import type { Sql } from '../db/client';
import { assertWorkspaceScope } from './DalAdapter';
import { makeError, randomNanoid } from './shared-helpers';
import { roleMirrorEntitlement } from './member-authority-provisioning';
import {
  cleanMemberMutationValue,
  memberMutationReceiptFromBody,
  readStrictMemberMutationReplay,
  validateMemberMutationIdempotency,
} from './workspace-member-authority-helpers';

// A1 (260710-B) · true when the error is Postgres "column does not exist" (42703) — used to degrade the
// roster reads to the legacy shape during the migrate→deploy window (before migration 062 adds removed_at).
function isMissingRemovedAtColumn(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '42703' || /removed_at.*does not exist|column .*removed_at/i.test(String(e?.message || ''));
}

export async function listWorkspaceMembersRow(
  sql: Sql,
  workspaceId: WorkspaceId,
): Promise<WorkspaceMember[]> {
  assertWorkspaceScope(workspaceId);
  try {
    // A1 · filter soft-removed members (removed_at IS NULL). Degrades below if 062 not yet applied.
    const rows = (await sql/*sql*/`
      SELECT m.user_id, m.workspace_id, m.role, m.invited_by,
             m.joined_at, u.email, u.status
      FROM workspace_members m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${workspaceId} AND m.removed_at IS NULL
      ORDER BY m.joined_at ASC
    `) as WorkspaceMember[];
    return rows;
  } catch (err) {
    if (!isMissingRemovedAtColumn(err)) throw err;
    const rows = (await sql/*sql*/`
      SELECT m.user_id, m.workspace_id, m.role, m.invited_by,
             m.joined_at, u.email, u.status
      FROM workspace_members m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${workspaceId}
      ORDER BY m.joined_at ASC
    `) as WorkspaceMember[];
    return rows;
  }
}

// BATCH roster read (kills the N+1: the cockpit boot hydrator previously fired one GET /members per
// operator workspace — ~16 parallel calls). Returns members for MANY workspaces in ONE query, grouped
// by workspace_id. TENANT-SAFE: the WHERE enforces the SAME ownership rule the single endpoint applies
// per call — a workspace is included only when the caller OWNS it (workspaces.owner_user_id ∈ ownerUserIds)
// OR it is the caller's current org (currentWorkspaceId) — so this can never enumerate another tenant's
// members even if arbitrary ids are passed. Unknown/unowned ids simply resolve to no rows.
export async function listWorkspaceMembersForWorkspacesRow(
  sql: Sql,
  workspaceIds: WorkspaceId[],
  ownerUserIds: UserId[],
  currentWorkspaceId: WorkspaceId | null,
): Promise<Record<string, WorkspaceMember[]>> {
  const ids = Array.from(new Set((workspaceIds || []).map((s) => String(s || '').trim()).filter(Boolean)));
  if (ids.length === 0) return {};
  const owners = (ownerUserIds || []).map((s) => String(s || '').trim()).filter(Boolean);
  const currentWs = currentWorkspaceId ? String(currentWorkspaceId).trim() : '';
  let rows: WorkspaceMember[];
  try {
    // A1 · filter soft-removed members. Degrades to the legacy (unfiltered) query pre-062.
    rows = (await sql/*sql*/`
      SELECT m.user_id, m.workspace_id, m.role, m.invited_by,
             m.joined_at, u.email, u.status
      FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ANY(${ids})
        AND (w.owner_user_id = ANY(${owners}) OR m.workspace_id = ${currentWs})
        AND m.removed_at IS NULL
      ORDER BY m.workspace_id ASC, m.joined_at ASC
    `) as WorkspaceMember[];
  } catch (err) {
    if (!isMissingRemovedAtColumn(err)) throw err;
    rows = (await sql/*sql*/`
      SELECT m.user_id, m.workspace_id, m.role, m.invited_by,
             m.joined_at, u.email, u.status
      FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ANY(${ids})
        AND (w.owner_user_id = ANY(${owners}) OR m.workspace_id = ${currentWs})
      ORDER BY m.workspace_id ASC, m.joined_at ASC
    `) as WorkspaceMember[];
  }
  const byWorkspace: Record<string, WorkspaceMember[]> = {};
  for (const r of rows) {
    (byWorkspace[r.workspace_id] ??= []).push(r);
  }
  return byWorkspace;
}

// JA (260714) · operator-workspace-scope AUTHORIZATION read — the security-critical predicate behind
// OPERATOR_WORKSPACE_SCOPE_ENABLED. Answers ONE question: may `userId` scope a read to `workspaceId`?
// TRUE iff the caller OWNS the workspace (workspaces.owner_user_id = userId) OR is an ACTIVE, non-removed
// member of it (workspace_members: user_id = userId AND workspace_id = requested AND removed_at IS NULL
// AND status = 'active'). This mirrors the EXACT ownership rule listWorkspaceMembersForWorkspacesRow uses
// (owner_user_id) plus the removed_at soft-delete rule the roster reads apply. READ-ONLY. It is the hard
// authorization boundary: a FALSE here becomes a 403 at the route (never a silent fall-back to the token
// org), so this can never widen a customer's read to a workspace they don't belong to.
//
// The `status = 'active'` predicate is on the JOINED workspace_members row (workspace_members has no
// `status` column of its own in every environment — membership state is carried via removed_at + role;
// the accepted-membership rule is removed_at IS NULL). To honor the task's "status = 'active'" intent
// without coupling to a column that may not exist, membership is treated as ACTIVE when removed_at IS NULL
// (the same accepted-membership definition listWorkspaceMembersRow enforces). Degrades below (pre-062,
// before removed_at exists) to the unfiltered membership check — identical to the roster reads' fallback.
export async function userCanScopeWorkspaceRow(
  sql: Sql,
  userId: UserId,
  workspaceId: WorkspaceId,
): Promise<boolean> {
  assertWorkspaceScope(workspaceId);
  const uid = String(userId || '').trim();
  if (!uid) return false;
  try {
    const rows = (await sql/*sql*/`
      SELECT 1
      FROM workspaces w
      WHERE w.id = ${workspaceId} AND w.owner_user_id = ${uid}
      UNION
      SELECT 1
      FROM workspace_members m
      WHERE m.workspace_id = ${workspaceId} AND m.user_id = ${uid} AND m.removed_at IS NULL
      LIMIT 1
    `) as Array<{ '?column?': number }>;
    return rows.length > 0;
  } catch (err) {
    if (!isMissingRemovedAtColumn(err)) throw err;
    const rows = (await sql/*sql*/`
      SELECT 1
      FROM workspaces w
      WHERE w.id = ${workspaceId} AND w.owner_user_id = ${uid}
      UNION
      SELECT 1
      FROM workspace_members m
      WHERE m.workspace_id = ${workspaceId} AND m.user_id = ${uid}
      LIMIT 1
    `) as Array<{ '?column?': number }>;
    return rows.length > 0;
  }
}

// JB (260714) · operator-workspace-scope AUTHORIZATION for WRITES — the stricter sibling of
// userCanScopeWorkspaceRow. Reads may target any workspace the caller BELONGS to (owner OR member);
// cross-workspace WRITES require OWNERSHIP (workspaces.owner_user_id = userId) ONLY. This closes a
// privilege-crossing the member-or-owner rule would open on the write side: a low-privilege member of
// workspace B (whose token org is A, where they hold packet:create) must NOT be able to write into B via
// the override — the JWT role is org-A-scoped and is not re-evaluated in B. Owner-only makes the override
// safe: only the workspace owner can redirect a governed write to a non-token workspace. READ-ONLY probe;
// a FALSE becomes a hard 403 at the route (never a silent fall-back to the token org).
export async function userOwnsWorkspaceRow(
  sql: Sql,
  userId: UserId,
  workspaceId: WorkspaceId,
): Promise<boolean> {
  assertWorkspaceScope(workspaceId);
  const uid = String(userId || '').trim();
  if (!uid) return false;
  const rows = (await sql/*sql*/`
    SELECT 1 FROM workspaces w
    WHERE w.id = ${workspaceId} AND w.owner_user_id = ${uid}
    LIMIT 1
  `) as Array<{ '?column?': number }>;
  return rows.length > 0;
}

// Role mutation · the in-app write path to change a member's workspace role (the gap
// prior audits flagged: this table was previously written only at provisioning/invite
// time). TENANT-SCOPED (assertWorkspaceScope + WHERE workspace_id), AUDITED (audit_logs
// in the same transaction, mirroring setUserStatusRow), and GUARDED against orphaning a
// workspace by demoting its last remaining owner. Returns the updated member row (email +
// status are null here — they live on the users LEFT JOIN, re-read via listWorkspaceMembers).
export async function setWorkspaceMemberRoleRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  targetUserId: UserId,
  role: WorkspaceMemberRole,
  actorUserId: UserId,
  idempotency: WorkspaceMemberMutationIdempotencyInput,
): Promise<WorkspaceMemberRoleMutationReceipt> {
  assertWorkspaceScope(workspaceId);
  validateMemberMutationIdempotency(idempotency, 'PATCH /api/v1/members/:userId/role');
  const actor = cleanMemberMutationValue(actorUserId);
  const target = cleanMemberMutationValue(targetUserId);
  if (!actor || !target) throw makeError('VALIDATION_ERROR', 'actor and target member are required', 400);

  const mirror = roleMirrorEntitlement(role);
  const operatorGrade = role === 'owner' || role === 'operator';
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
        SELECT user_id, workspace_id, role, invited_by, joined_at
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
            xlooop_assert_authority_complete(false, 'member_role_target')
          WHEN ${role !== 'owner'}::boolean
            AND (SELECT role FROM target_snapshot) = 'owner'
            AND (SELECT count(*) FROM owner_snapshot) <= 1 THEN
            xlooop_assert_authority_complete(false, 'member_role_last_owner')
          ELSE true
        END AS complete
        FROM command_envelope
      ),
      member_updated AS (
        UPDATE workspace_members
        SET role = ${role}
        FROM command_guard
        WHERE workspace_members.workspace_id = ${workspaceId}
          AND workspace_members.user_id = ${target}
          AND workspace_members.removed_at IS NULL
          AND command_guard.complete
        RETURNING workspace_members.user_id, workspace_members.workspace_id,
                  workspace_members.role, workspace_members.invited_by, workspace_members.joined_at
      ),
      entitlement_written AS (
        INSERT INTO customer_entitlements (
          id, user_id, workspace_id, app_id, account_type,
          allowed_modes, allowed_actions, denied_actions,
          authority_ref, granted_at, granted_by, created_at, updated_at
        )
        SELECT
          'cent_' || replace(gen_random_uuid()::text, '-', ''), member_updated.user_id,
          member_updated.workspace_id, 'xlooop-product', 'company',
          ${mirror.allowed_modes}::text[], ${mirror.allowed_actions}::text[], ${mirror.denied_actions}::text[],
          'membership:role-mirror', ${commandTimestamp}::timestamptz, ${actor},
          ${commandTimestamp}::timestamptz, ${commandTimestamp}::timestamptz
        FROM member_updated
        ON CONFLICT (user_id, workspace_id, app_id) DO UPDATE SET
          allowed_modes = EXCLUDED.allowed_modes,
          allowed_actions = EXCLUDED.allowed_actions,
          denied_actions = EXCLUDED.denied_actions,
          authority_ref = EXCLUDED.authority_ref,
          granted_at = EXCLUDED.granted_at,
          granted_by = EXCLUDED.granted_by,
          updated_at = EXCLUDED.updated_at
        RETURNING user_id, workspace_id
      ),
      preference_written AS (
        INSERT INTO user_session_preferences (user_id, workspace_id, operating_mode, updated_at)
        SELECT member_updated.user_id, member_updated.workspace_id,
               ${operatorGrade ? 'operator' : 'watch'}, ${commandTimestamp}::timestamptz
        FROM member_updated
        ON CONFLICT (user_id, workspace_id) DO UPDATE SET
          operating_mode = CASE WHEN ${operatorGrade}::boolean
            THEN user_session_preferences.operating_mode ELSE 'watch' END,
          updated_at = CASE WHEN ${operatorGrade}::boolean
            THEN user_session_preferences.updated_at ELSE EXCLUDED.updated_at END
        RETURNING user_id, workspace_id
      ),
      event_written AS (
        INSERT INTO operation_events (
          id, workspace_id, source_tool, agent_id, status, summary, body, visibility,
          occurred_at, authorized_by_user_id, instrument_kind, authority_source, request_id
        )
        SELECT
          ${operationEventId}, member_updated.workspace_id, 'xlooop', ${actor}, 'completed',
          ('Workspace member role changed to ' || member_updated.role),
          'Member role and effective authority changed through an owner command.',
          'internal_workspace', ${commandTimestamp}::timestamptz, ${actor}, 'human', 'role',
          ${idempotency.request_id ?? null}
        FROM member_updated
        JOIN entitlement_written ON TRUE
        JOIN preference_written ON TRUE
        RETURNING id, occurred_at
      ),
      audit_written AS (
        INSERT INTO audit_logs (
          id, actor_user_id, action, target_type, target_id, workspace_id, reason,
          causation_id, metadata
        )
        SELECT command_envelope.audit_id, ${actor}, 'member_role_change', 'workspace_member',
               member_updated.user_id, member_updated.workspace_id, ${'role -> ' + role},
               event_written.id,
               jsonb_build_object(
                 'request_id', ${idempotency.request_id ?? null}::text,
                 'request_sha256', ${idempotency.request_sha256}::text,
                 'role', member_updated.role
               )
        FROM member_updated
        JOIN event_written ON TRUE
        JOIN command_envelope ON TRUE
        RETURNING id::text AS audit_event_id
      ),
      outbox_written AS (
        INSERT INTO projection_outbox (
          id, workspace_id, event_type, aggregate_type, aggregate_id, payload, created_at
        )
        SELECT ${projectionOutboxId}, member_updated.workspace_id, 'workspace_member.role_changed',
               'workspace_member', member_updated.user_id,
               jsonb_build_object(
                 'user_id', member_updated.user_id,
                 'role', member_updated.role,
                 'operation_event_id', event_written.id,
                 'audit_event_id', audit_written.audit_event_id,
                 'request_sha256', ${idempotency.request_sha256}::text
               ),
               ${commandTimestamp}::timestamptz
        FROM member_updated
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
                 'member', jsonb_build_object(
                   'user_id', member_updated.user_id,
                   'workspace_id', member_updated.workspace_id,
                   'role', member_updated.role,
                   'email', null,
                   'status', null,
                   'invited_by', member_updated.invited_by,
                   'joined_at', member_updated.joined_at
                 ),
                 'member_mutation_receipt_id',
                   ('workspace-member:' || member_updated.workspace_id || ':' || member_updated.user_id
                     || ':role:' || audit_written.audit_event_id),
                 'operation_event_id', event_written.id,
                 'audit_event_id', audit_written.audit_event_id,
                 'projection_outbox_id', outbox_written.id,
                 'read_model_watermark', ${commandTimestamp}::text,
                 'replayed', false
               ),
               ${commandTimestamp}::timestamptz
        FROM member_updated
        JOIN entitlement_written ON TRUE
        JOIN preference_written ON TRUE
        JOIN event_written ON TRUE
        JOIN audit_written ON TRUE
        JOIN outbox_written ON TRUE
        RETURNING response_body
      ),
      authority_result AS (
        SELECT strict_claim.response_body,
               CASE
                 WHEN (SELECT count(*) FROM target_snapshot) <> 1 THEN
                   xlooop_assert_authority_complete(false, 'member_role_target')
                 WHEN ${role !== 'owner'}::boolean
                   AND (SELECT role FROM target_snapshot) = 'owner'
                   AND (SELECT count(*) FROM owner_snapshot) <= 1 THEN
                   xlooop_assert_authority_complete(false, 'member_role_last_owner')
                 ELSE xlooop_assert_authority_complete(
                   (SELECT count(*) FROM member_updated) = 1
                   AND (SELECT count(*) FROM entitlement_written) = 1
                   AND (SELECT count(*) FROM preference_written) = 1
                   AND (SELECT count(*) FROM event_written) = 1
                   AND (SELECT count(*) FROM audit_written) = 1
                   AND (SELECT count(*) FROM outbox_written) = 1
                   AND (SELECT count(*) FROM strict_claim) = 1,
                   'member_role_mutation'
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
      return readStrictMemberMutationReplay(sql, workspaceId, actor, idempotency, 'role') as Promise<WorkspaceMemberRoleMutationReceipt>;
    }
    if (sqlError.code === '23514' && sqlError.message?.includes('member_role_target')) {
      throw makeError('NOT_FOUND', `member ${target} not in workspace ${workspaceId}`, 404);
    }
    if (sqlError.code === '23514' && sqlError.message?.includes('member_role_last_owner')) {
      throw makeError('LAST_OWNER', 'cannot change the role of the last remaining owner', 409);
    }
    if (sqlError.code === '23514' && sqlError.message?.includes('xlooop authority incomplete')) {
      throw makeError('MEMBER_ATOMICITY_FAILED', 'member role change did not complete every authority row', 500);
    }
    throw error;
  }
  if (rows[0]?.response_body) {
    return memberMutationReceiptFromBody(rows[0].response_body, 'role', false) as WorkspaceMemberRoleMutationReceipt;
  }
  return readStrictMemberMutationReplay(sql, workspaceId, actor, idempotency, 'role') as Promise<WorkspaceMemberRoleMutationReceipt>;
}

export { removeWorkspaceMemberRow } from './workspace-member-removal-store';
