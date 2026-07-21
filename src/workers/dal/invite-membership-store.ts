// invite-membership-store.ts · AI-EXEC-2 (260721) · materialize an invited teammate's workspace membership.
//
// THE GAP THIS CLOSES: an owner invites a colleague via POST /customer/invites → a Clerk org invitation.
// The invitee accepts + signs in — and DEAD-ENDS: the session flow only ever writes `owner` rows
// (self-bootstrap / auto-provision), so an org:member/org:admin invitee lands in authenticated_no_access
// with no membership. This materializes it, at session time, from the invitee's OWN Clerk org claims — the
// cryptographic proof of an accepted invitation (Clerk signs org_id/org_role only for accepted members), so
// no webhook infrastructure is needed (none exists; session-time is the house pattern).
//
// SAFETY — this is a GOVERNED WRITE on the tenant-access boundary (the highest-consequence surface):
//   - role comes ONLY from the caller's clerkRoleToWorkspaceRole mapping (org:admin→operator,
//     org:member→viewer). This function REFUSES anything but viewer/operator — never `owner` (ownership
//     stays a create-time act) and never `client` (no Clerk role maps to it; the redaction boundary is
//     never auto-granted).
//   - materialize ONLY when the workspace EXISTS and the user has NO member row (ANY status) — so it never
//     resurrects a soft-removed member, never demotes an owner, never mutates an existing row. ON CONFLICT
//     DO NOTHING is the race backstop for the same invariant.
//   - NEVER un-bans: a rejected/suspended user is left untouched (pre-checked AND a conditional ON CONFLICT
//     WHERE on the users upsert).
//   - invitation-is-approval: the users row is approved (the org owner vouched — global "may use the
//     product"), which is NOT cross-workspace access (that still requires a member row per workspace).
//   - the call site is flag-gated born-OFF (INVITE_MEMBERSHIP_MATERIALIZATION_ENABLED); byte-inert until on.

import type { Sql } from '../db/client';
import type { WorkspaceRole } from './types/identity';
import { memberAuthorityProvisioningStatements } from './member-authority-provisioning';

export interface MaterializeInvitedMembershipInput {
  workspaceId: string;
  userId: string;
  /** Already mapped from the Clerk org role by the caller. MUST be 'viewer' or 'operator'. */
  role: WorkspaceRole;
}

export interface MaterializeInvitedMembershipResult {
  materialized: boolean;
  role: WorkspaceRole | null;
  reason: 'ok' | 'role_not_joinable' | 'invalid_input' | 'workspace_not_found' | 'member_exists' | 'user_banned';
}

export async function materializeInvitedMembershipRow(
  sql: Sql,
  input: MaterializeInvitedMembershipInput,
): Promise<MaterializeInvitedMembershipResult> {
  const workspaceId = String(input.workspaceId || '').trim();
  const userId = String(input.userId || '').trim();
  const role = input.role;

  // owner/client are NEVER materialized via an invite: owner is a create-time act; client is the redaction
  // boundary that only lands behind the leak-test suite. Only viewer/operator are join-able.
  if (role !== 'viewer' && role !== 'operator') return { materialized: false, role: null, reason: 'role_not_joinable' };
  if (!workspaceId || !userId) return { materialized: false, role: null, reason: 'invalid_input' };

  // Guard 1 — the workspace must EXIST (this path joins an existing workspace; it never creates one).
  const ws = (await sql/*sql*/`SELECT id FROM workspaces WHERE id = ${workspaceId} LIMIT 1`) as Array<{ id: string }>;
  if (!ws.length) return { materialized: false, role: null, reason: 'workspace_not_found' };

  // Guard 2 — never touch an existing member row (any status): no resurrect, no demote.
  const existing = (await sql/*sql*/`
    SELECT 1 AS x FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${userId} LIMIT 1
  `) as Array<{ x: number }>;
  if (existing.length) return { materialized: false, role: null, reason: 'member_exists' };

  // Guard 3 — never un-ban a rejected/suspended user (a platform-level ban outranks an org invite).
  const u = (await sql/*sql*/`SELECT status FROM users WHERE id = ${userId} LIMIT 1`) as Array<{ status: string }>;
  if (u.length && (u[0].status === 'rejected' || u[0].status === 'suspended')) {
    return { materialized: false, role: null, reason: 'user_banned' };
  }

  const actor = 'invite-materialization';
  const stmts: unknown[] = [
    // approve the invitee (invitation-is-approval); the WHERE keeps a banned user banned even if reached.
    sql/*sql*/`
      INSERT INTO users (id, status, approved_at, approved_by)
      VALUES (${userId}, 'approved', now(), ${actor})
      ON CONFLICT (id) DO UPDATE SET status = 'approved',
        approved_at = COALESCE(users.approved_at, EXCLUDED.approved_at), updated_at = now()
      WHERE users.status NOT IN ('rejected', 'suspended')
    `,
    // the active member row at the Clerk-mapped role; DO NOTHING is the race backstop for guard 2.
    sql/*sql*/`
      INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at, activated_by)
      VALUES (${workspaceId}, ${userId}, ${role}, 'active', now(), ${actor})
      ON CONFLICT (workspace_id, user_id) DO NOTHING
    `,
    // entitlement + operating-mode axes in the SAME txn (a member row never commits without its authority).
    ...(memberAuthorityProvisioningStatements(sql, { userId, workspaceId, role, actorUserId: actor }) as unknown[]),
    sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      VALUES (${userId}, 'member_activate', 'workspace_member', ${userId}, ${workspaceId}, 'invite-membership-materialization')
    `,
  ];
  await (sql as unknown as { transaction: (q: unknown[]) => Promise<unknown> }).transaction(stmts);
  return { materialized: true, role, reason: 'ok' };
}
