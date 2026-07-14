// user-store.ts · user-identity read + admin status-mutation group.
//
// Authority: DATABASE_SCHEMA_V1.md (users, audit_logs) · API_CONTRACT_V1.md ·
// AUTH_TENANCY_MODEL.md. Lifted verbatim out of WorkersDalAdapter (Stage 3.1, F10) to
// decompose the DAL god-object; behaviour is byte-for-byte identical to the prior inline
// methods.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). makeError is
// imported from ./shared-helpers (same call shape). These methods are NOT workspace-scoped
// (the users table is global identity; admin route-layer enforces the admin gate), so there
// is no assertWorkspaceScope call — identical to the inline originals. setUserStatusRow keeps
// the sql.transaction([...]) two-statement shape EXACTLY (UPDATE users + audit_logs INSERT
// with the (actor_user_id, action, target_type, target_id, reason) column form the inline
// method used — note: no workspace_id/metadata columns here, unlike appendAuditLog).

import { makeError } from './shared-helpers';
import type {
  UserId,
  User,
  UserStatus,
  UserListOpts,
} from './types';
import type { Sql, SqlTx } from '../db/client';

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function getUserRow(sql: Sql, userId: UserId): Promise<User | null> {
  const rows = (await sql/*sql*/`
    SELECT id, email, status, is_admin, approved_at, approved_by,
           rejection_reason, suspended_at, metadata, created_at, updated_at
    FROM users WHERE id = ${userId} LIMIT 1
  `) as User[];
  return rows[0] ?? null;
}

// Part R · Stage B (260628) · case-insensitive lookup by email — used to mark an access-request
// lead as "registered" (a users row exists) vs an anonymous website lead (no users row yet).
export async function getUserByEmailRow(sql: Sql, email: string): Promise<User | null> {
  if (!email) return null;
  const rows = (await sql/*sql*/`
    SELECT id, email, status, is_admin, approved_at, approved_by,
           rejection_reason, suspended_at, metadata, created_at, updated_at
    FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `) as User[];
  return rows[0] ?? null;
}

export async function listUsersRow(sql: Sql, opts: UserListOpts): Promise<User[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const statusFilter = opts.status ?? null;
  const rows = (await sql/*sql*/`
    SELECT id, email, status, is_admin, approved_at, approved_by,
           rejection_reason, suspended_at, metadata, created_at, updated_at
    FROM users
    WHERE (${statusFilter}::text IS NULL OR status = ${statusFilter}::text)
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as User[];
  return rows;
}

export async function setUserStatusRow(
  sql: Sql,
  userId: UserId,
  status: UserStatus,
  actorUserId: UserId,
  opts?: { rejection_reason?: string }
): Promise<User> {
  const rejectionReason = opts?.rejection_reason ?? null;
  const action: 'user_approve' | 'user_reject' | 'user_suspend' | 'user_unsuspend' =
    status === 'approved' ? 'user_approve'
    : status === 'rejected' ? 'user_reject'
    : status === 'suspended' ? 'user_suspend'
    : 'user_unsuspend';

  const [userRows] = (await (sql as SqlTx).transaction([
    sql/*sql*/`
      UPDATE users
      SET status = ${status},
          approved_at = CASE WHEN ${status} = 'approved' AND approved_at IS NULL THEN now() ELSE approved_at END,
          approved_by = CASE WHEN ${status} = 'approved' AND approved_by IS NULL THEN ${actorUserId} ELSE approved_by END,
          rejection_reason = CASE WHEN ${status} = 'rejected' THEN ${rejectionReason} ELSE rejection_reason END,
          suspended_at = CASE WHEN ${status} = 'suspended' THEN now() ELSE NULL END,
          updated_at = now()
      WHERE id = ${userId}
      RETURNING id, email, status, is_admin, approved_at, approved_by,
                rejection_reason, suspended_at, metadata, created_at, updated_at
    `,
    sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, reason)
      VALUES (${actorUserId}, ${action}::text, 'user', ${userId}, ${rejectionReason})
    `,
  ])) as [User[], unknown];

  if (!userRows[0]) {
    throw makeError('NOT_FOUND', `user ${userId} not found`, 404);
  }
  return userRows[0];
}
