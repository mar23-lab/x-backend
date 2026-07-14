// session-store.ts · session-context read (/api/v1/session) + operator self-bootstrap (R43.18).
//
// Authority: API_CONTRACT_V1.md (/api/v1/session) · AUTH_TENANCY_MODEL.md · DATABASE_SCHEMA_V1.md
// (workspaces, workspace_members, projects, users, audit_logs). Lifted verbatim out of
// WorkersDalAdapter (Stage 3.1, F10) to decompose the DAL god-object; behaviour is byte-for-byte
// identical to the prior inline methods.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). getSessionRow keeps
// assertWorkspaceScope (imported from ./DalAdapter) + makeError (./shared-helpers); bootstrapOperator
// validates userId/workspaceId only (no assertWorkspaceScope — it provisions a NEW workspace, so it
// cannot pre-assert tenancy) and writes its own inline audit_logs row (does NOT call the class
// appendAuditLog — identical to the inline original). getSessionEntitlement STAYS on the DAL
// coordinator (per the decomposition plan: it is the entitlement source-of-truth core).

import { assertWorkspaceScope } from './DalAdapter';
import { makeError } from './shared-helpers';
import { ensureMemberAuthorityProvisioned } from './member-authority-provisioning';
import type {
  WorkspaceId,
  UserId,
  SessionContext,
  WorkspaceRole,
  Project,
} from './types';
import type { Sql } from '../db/client';

// ------------------------------------------------------------
// /api/v1/session
// ------------------------------------------------------------

export async function getSessionRow(sql: Sql, userId: UserId, workspaceId: WorkspaceId): Promise<SessionContext> {
  assertWorkspaceScope(workspaceId);
  if (!userId) throw makeError('UNAUTHORIZED', 'user_id required', 401);

  const wsRows = (await sql/*sql*/`
    SELECT id, name, slug
    FROM workspaces
    WHERE id = ${workspaceId}
    LIMIT 1
  `) as Array<{ id: string; name: string; slug: string | null }>;

  if (wsRows.length === 0) {
    throw makeError('NOT_FOUND', `workspace ${workspaceId} not found`, 404);
  }
  const ws = wsRows[0]!;

  const memberRows = (await sql/*sql*/`
    SELECT role
    FROM workspace_members
    WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    LIMIT 1
  `) as Array<{ role: WorkspaceRole }>;

  const role: WorkspaceRole = memberRows[0]?.role ?? 'viewer';

  const projectRows = (await sql/*sql*/`
    SELECT id, name, status
    FROM projects
    WHERE workspace_id = ${workspaceId} AND status != 'archived'
    ORDER BY created_at DESC
    LIMIT 200
  `) as Array<{ id: string; name: string; status: Project['status'] }>;

  return {
    user: { id: userId, email: '', role },
    workspace: { id: ws.id, name: ws.name, slug: ws.slug },
    projects: projectRows.map(p => ({ id: p.id, name: p.name, status: p.status })),
  };
}

// ------------------------------------------------------------
// R43.18 · Operator self-bootstrap
// ------------------------------------------------------------

export async function bootstrapOperatorRow(sql: Sql, args: {
  userId: UserId;
  workspaceId: WorkspaceId;
  workspaceName: string;
  workspaceSlug: string;
  email: string | null;
}): Promise<{ workspace_id: WorkspaceId; workspace_name: string }> {
  const { userId, workspaceId, workspaceName, workspaceSlug, email } = args;
  if (!userId) throw makeError('VALIDATION_ERROR', 'userId required', 400);
  if (!workspaceId) throw makeError('VALIDATION_ERROR', 'workspaceId required', 400);

  // 1. UPSERT user as approved · only flips status to approved on INSERT or
  //    when the existing row is still pending. Does NOT override rejected/
  //    suspended status (so admin actions remain authoritative).
  await sql/*sql*/`
    INSERT INTO users (id, email, status, is_admin, approved_at, approved_by)
    VALUES (${userId}, ${email ?? null}, 'approved', true, now(), ${userId})
    ON CONFLICT (id) DO UPDATE
      SET status = CASE
            WHEN users.status IN ('rejected', 'suspended') THEN users.status
            ELSE 'approved'
          END,
          is_admin = true,
          approved_at = COALESCE(users.approved_at, EXCLUDED.approved_at),
          approved_by = COALESCE(users.approved_by, EXCLUDED.approved_by),
          email = COALESCE(EXCLUDED.email, users.email),
          updated_at = now()
  `;

  // 2. UPSERT workspace
  await sql/*sql*/`
    INSERT INTO workspaces (id, name, owner_user_id, slug)
    VALUES (${workspaceId}, ${workspaceName}, ${userId}, ${workspaceSlug})
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          slug = COALESCE(workspaces.slug, EXCLUDED.slug),
          updated_at = now()
  `;

  // 3. UPSERT workspace_member as active owner
  await sql/*sql*/`
    INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at, activated_by)
    VALUES (${workspaceId}, ${userId}, 'owner', 'active', now(), ${userId})
    ON CONFLICT (workspace_id, user_id) DO UPDATE
      SET role = 'owner',
          status = 'active',
          activated_at = COALESCE(workspace_members.activated_at, EXCLUDED.activated_at),
          activated_by = COALESCE(workspace_members.activated_by, EXCLUDED.activated_by)
  `;

  // 3b. P5(a) §5e: keep the entitlement + operating-mode axes in lockstep with the membership (degrade-safe).
  await ensureMemberAuthorityProvisioned(sql, { userId, workspaceId, role: 'owner', actorUserId: userId });

  // 4. Audit log entry (idempotency lives in the audit trail; we always
  //    write so post-hoc inspection shows bootstrap fired on this request).
  try {
    await sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      VALUES (${userId}, 'operator_self_bootstrap', 'user', ${userId}, ${workspaceId}, 'R43.18 · MBP_OWNER_USER_ID auto-bootstrap on /session call')
    `;
  } catch (e) {
    // audit insert is non-critical for the bootstrap itself
    void e;
  }

  return { workspace_id: workspaceId, workspace_name: workspaceName };
}
