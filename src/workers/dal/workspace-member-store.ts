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

import type { UserId, WorkspaceId, WorkspaceMember, WorkspaceMemberRole } from './types';
import type { Sql, SqlTx } from '../db/client';
import { assertWorkspaceScope } from './DalAdapter';
import { makeError } from './shared-helpers';
import { memberAuthorityProvisioningStatements } from './member-authority-provisioning';

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
): Promise<WorkspaceMember> {
  assertWorkspaceScope(workspaceId);

  // Guard: never orphan a workspace by demoting/removing its last owner.
  if (role !== 'owner') {
    const current = (await sql/*sql*/`
      SELECT role FROM workspace_members
      WHERE workspace_id = ${workspaceId} AND user_id = ${targetUserId}
    `) as Array<{ role: WorkspaceMemberRole }>;
    if (!current[0]) {
      throw makeError('NOT_FOUND', `member ${targetUserId} not in workspace ${workspaceId}`, 404);
    }
    if (current[0].role === 'owner') {
      const owners = (await sql/*sql*/`
        SELECT count(*)::int AS n FROM workspace_members
        WHERE workspace_id = ${workspaceId} AND role = 'owner'
      `) as Array<{ n: number }>;
      if ((owners[0]?.n ?? 0) <= 1) {
        throw makeError('LAST_OWNER', 'cannot change the role of the last remaining owner', 409);
      }
    }
  }

  const [rows] = (await (sql as SqlTx).transaction([
    sql/*sql*/`
      UPDATE workspace_members
      SET role = ${role}
      WHERE workspace_id = ${workspaceId} AND user_id = ${targetUserId}
      RETURNING user_id, workspace_id, role, invited_by, joined_at
    `,
    sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      VALUES (${actorUserId}, 'member_role_change'::text, 'workspace_member', ${targetUserId}, ${workspaceId}, ${'role -> ' + role})
    `,
    // P5(a) §5e: a role change re-mirrors the entitlement + operating-mode axes IN THE SAME TRANSACTION —
    // promote seeds operator authority; demote downgrades it (else a post-flip demotion would be a lie).
    ...(memberAuthorityProvisioningStatements(sql, {
      userId: targetUserId, workspaceId, role, actorUserId,
    }) as never[]),
  ])) as [Array<Omit<WorkspaceMember, 'email' | 'status'>>, unknown];

  if (!rows[0]) {
    throw makeError('NOT_FOUND', `member ${targetUserId} not in workspace ${workspaceId}`, 404);
  }
  return { ...rows[0], email: null, status: null } as WorkspaceMember;
}

// A1 (260710-B) · SOFT-remove a member from a workspace (backs the cockpit "Remove from workspace" control).
// Mirrors setWorkspaceMemberRoleRow: TENANT-SCOPED (assertWorkspaceScope + WHERE workspace_id), AUDITED
// ('member_removed' in the same transaction), and GUARDED so it can never orphan a workspace. Removal is
// SOFT (removed_at) because workspace_members is on the no-hard-delete protected list.
//
// ENTITLEMENT NOTE (deliberate scope boundary): removal does NOT touch customer_entitlements here.
// (DAL-03 260711-J correction: the grain is post-054 UNIQUE(user_id, workspace_id, app_id) — per-workspace,
// confirmed by member-authority-provisioning.ts ON CONFLICT (user_id, workspace_id, app_id). So a
// workspace-keyed revoke would be correctly scoped; the earlier "over-revoke across workspaces" rationale
// is obsolete.) The deferral still stands for a different reason: enforcement is flag-off today (inert),
// and the ENTITLEMENT_ENFORCEMENT flip (Tranche C) re-derives authority from LIVE membership; that
// derivation must exclude soft-removed members (removed_at IS NOT NULL) — tracked as the flip's
// responsibility, not this membership write's. Keeping this fn bounded to membership + audit is the clean
// seam, not a grain-safety workaround.
// Guards:
//   - a caller cannot remove THEMSELVES (leave-workspace is a separate, deliberate flow) → 409;
//   - the LAST remaining owner cannot be removed (would orphan the workspace) → 409 LAST_OWNER;
//   - the member must exist + not already be removed → 404.
export async function removeWorkspaceMemberRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  targetUserId: UserId,
  actorUserId: UserId,
): Promise<{ user_id: UserId; workspace_id: WorkspaceId; removed_at: string }> {
  assertWorkspaceScope(workspaceId);

  if (String(targetUserId) === String(actorUserId)) {
    throw makeError('CANNOT_REMOVE_SELF', 'you cannot remove yourself from the workspace', 409);
  }

  const current = (await sql/*sql*/`
    SELECT role FROM workspace_members
    WHERE workspace_id = ${workspaceId} AND user_id = ${targetUserId} AND removed_at IS NULL
  `) as Array<{ role: WorkspaceMemberRole }>;
  if (!current[0]) {
    throw makeError('NOT_FOUND', `member ${targetUserId} not in workspace ${workspaceId}`, 404);
  }
  if (current[0].role === 'owner') {
    const owners = (await sql/*sql*/`
      SELECT count(*)::int AS n FROM workspace_members
      WHERE workspace_id = ${workspaceId} AND role = 'owner' AND removed_at IS NULL
    `) as Array<{ n: number }>;
    if ((owners[0]?.n ?? 0) <= 1) {
      throw makeError('LAST_OWNER', 'cannot remove the last remaining owner', 409);
    }
  }

  const [rows] = (await (sql as SqlTx).transaction([
    sql/*sql*/`
      UPDATE workspace_members
      SET removed_at = now()
      WHERE workspace_id = ${workspaceId} AND user_id = ${targetUserId} AND removed_at IS NULL
      RETURNING user_id, workspace_id, removed_at
    `,
    sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      VALUES (${actorUserId}, 'member_removed'::text, 'workspace_member', ${targetUserId}, ${workspaceId}, ${'removed from workspace'})
    `,
  ])) as [Array<{ user_id: UserId; workspace_id: WorkspaceId; removed_at: string }>, unknown];

  if (!rows[0]) {
    throw makeError('NOT_FOUND', `member ${targetUserId} not in workspace ${workspaceId}`, 404);
  }
  return rows[0];
}
