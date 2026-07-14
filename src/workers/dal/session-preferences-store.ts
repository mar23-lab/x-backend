// session-preferences-store.ts · Wave B (260707) · canonical operating-mode persistence.
//
// The operating mode (watch/test/operator) is a per-(user, workspace) presentation preference. It was
// client-only (localStorage) until this store gave it a canonical server home (migration 052,
// user_session_preferences). Reads default to 'watch' when no row exists. Writes UPSERT + append an
// audit_logs row in the SAME transaction (audited per flip, mirroring setWorkspaceMemberRoleRow). TENANT +
// USER scoped: every query is `WHERE user_id = $u AND workspace_id = $w`, so a caller only ever reads/writes
// their OWN mode in a given workspace — this can never touch another user's or another tenant's row.

import type { Sql } from '../db/client';
import type { UserId, WorkspaceId } from './types';

export const OPERATING_MODES = ['watch', 'test', 'operator'] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

export function isOperatingMode(v: unknown): v is OperatingMode {
  return typeof v === 'string' && (OPERATING_MODES as readonly string[]).includes(v);
}

/** The caller's persisted operating mode for a workspace, or 'watch' (the safe default) when unset/pre-052. */
export async function getOperatingModeRow(sql: Sql, userId: UserId, workspaceId: WorkspaceId): Promise<OperatingMode> {
  if (!userId || !workspaceId) return 'watch';
  try {
    const rows = (await sql/*sql*/`
      SELECT operating_mode FROM user_session_preferences
      WHERE user_id = ${userId} AND workspace_id = ${workspaceId}
      LIMIT 1
    `) as Array<{ operating_mode: string }>;
    const m = rows[0]?.operating_mode;
    return isOperatingMode(m) ? m : 'watch';
  } catch {
    // Degrade-safe: pre-052 (table absent) or transient error → the presentation default, never a throw.
    return 'watch';
  }
}

/** Set the caller's operating mode for a workspace (UPSERT) + append an audit row, in one transaction. */
export async function setOperatingModeRow(
  sql: Sql,
  userId: UserId,
  workspaceId: WorkspaceId,
  mode: OperatingMode,
  actorUserId: UserId,
): Promise<OperatingMode> {
  await (sql as unknown as { transaction: (q: unknown[]) => Promise<unknown> }).transaction([
    sql/*sql*/`
      INSERT INTO user_session_preferences (user_id, workspace_id, operating_mode, updated_at)
      VALUES (${userId}, ${workspaceId}, ${mode}, now())
      ON CONFLICT (user_id, workspace_id)
      DO UPDATE SET operating_mode = EXCLUDED.operating_mode, updated_at = now()
    `,
    sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      VALUES (${actorUserId}, 'operating_mode_change'::text, 'session', ${userId}, ${workspaceId}, ${'mode -> ' + mode})
    `,
  ]);
  return mode;
}
