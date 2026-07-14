// workspace-store.ts · operator-owned workspace CRUD + ownership-gate group.
//
// Authority: DATABASE_SCHEMA_V1.md (workspaces, workspace_members) · API_CONTRACT_V1.md ·
// AUTH_TENANCY_MODEL.md. Lifted verbatim out of WorkersDalAdapter (Stage 3.1, F10) to
// decompose the DAL god-object; behaviour is byte-for-byte identical to the prior inline
// methods.
//
// These methods are OPERATOR-IDENTITY scoped (owner_user_id ∈ ids), NOT workspace_id-scoped,
// so there is no assertWorkspaceScope call — identical to the inline originals. makeError is
// imported from ./shared-helpers (same call shape).
//
// createWorkspaceRow preserves the slug-collision retry EXACTLY (clean human slug first, fall
// back to the globally-unique id as slug on a slug-unique violation) AND the creator owner-member
// insert (workspace_members role='owner' status='active', ON CONFLICT DO NOTHING) — without that
// member row the new workspace is invisible to the membership-scoped cockpit. The workspace_members
// insert is NOT extracted to customer-provisioning-store; it is replicated inline here exactly as
// the inline method did, so the two paths stay independent + identical.

import { makeError } from './shared-helpers';
import { ensureMemberAuthorityProvisioned } from './member-authority-provisioning';
import type {
  UserId,
  WorkspaceId,
  WorkspaceRow,
  WorkspaceCreateInput,
} from './types';
import type { Sql } from '../db/client';

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function operatorOwnsWorkspaceRow(sql: Sql, ownerUserIds: string[], workspaceId: string): Promise<boolean> {
  const ids = (Array.isArray(ownerUserIds) ? ownerUserIds : [ownerUserIds]).filter(Boolean);
  if (ids.length === 0 || !workspaceId) return false;
  const rows = (await sql/*sql*/`
    SELECT 1 FROM workspaces WHERE id = ${workspaceId} AND owner_user_id = ANY(${ids}) LIMIT 1
  `) as Array<unknown>;
  return rows.length > 0;
}

// Plain (NON owner-scoped) existence check — for admin/operator contexts that act across tenants
// (e.g. the customer-approval inbox), where the caller is admin-gated, not owner-gated. Used to
// reject a typo'd / nonexistent workspace_id before writing an authority row (no orphaned rows).
export async function workspaceExistsRow(sql: Sql, workspaceId: string): Promise<boolean> {
  if (!workspaceId) return false;
  const rows = (await sql/*sql*/`
    SELECT 1 FROM workspaces WHERE id = ${workspaceId} LIMIT 1
  `) as Array<unknown>;
  return rows.length > 0;
}

export async function createWorkspaceRow(
  sql: Sql,
  input: WorkspaceCreateInput,
  ownerUserId: UserId,
): Promise<WorkspaceRow> {
  if (!ownerUserId) throw makeError('VALIDATION_ERROR', 'owner required', 400);
  const name = (input?.name || '').trim();
  if (!name || name.length > 200) throw makeError('VALIDATION_ERROR', 'name 1-200 chars required', 400);
  const baseSlug = (input.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workspace';
  // Always a FRESH id so operator-create can NEVER overwrite an existing
  // workspace (no ON CONFLICT path that could rename another tenant's row).
  const newId = `${baseSlug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cfgJson = JSON.stringify(input.config ?? {});
  // R55-x (2026-06-06): workspaces.slug is UNIQUE (001_init.sql). Deriving the slug
  // from the (possibly duplicate) workspace NAME made create-workspace throw a
  // unique-violation -> errorEnvelope -> HTTP 500 whenever the name collided with an
  // existing workspace's slug (observed by the operator creating a workspace). The id
  // is always unique (suffix), so only the slug can collide. Try the clean human slug
  // first; on a slug collision fall back to the globally-unique id as the slug so
  // operator create never 500s. A genuine non-slug error re-throws on the retry.
  let rows: Array<WorkspaceRow>;
  try {
    rows = await sql/*sql*/`
      INSERT INTO workspaces (id, name, owner_user_id, slug, config)
      VALUES (${newId}, ${name}, ${ownerUserId}, ${baseSlug}, ${cfgJson}::jsonb)
      RETURNING id, name, owner_user_id, slug, config, created_at, updated_at
    ` as Array<WorkspaceRow>;
  } catch (_slugCollision) {
    rows = await sql/*sql*/`
      INSERT INTO workspaces (id, name, owner_user_id, slug, config)
      VALUES (${newId}, ${name}, ${ownerUserId}, ${newId}, ${cfgJson}::jsonb)
      RETURNING id, name, owner_user_id, slug, config, created_at, updated_at
    ` as Array<WorkspaceRow>;
  }
  // R55-x (2026-06-06): add the creator as an active OWNER-member so the new
  // workspace is VISIBLE. Without this, createWorkspace wrote the `workspaces`
  // row (owner_user_id set) but NO `workspace_members` row, so a created
  // workspace ("test") had 0 memberships -> it never appeared in the cockpit
  // (which is membership-scoped) and its projects/features were inaccessible.
  // Mirrors the R43.18 operator-bootstrap owner-member insert. ON CONFLICT keeps
  // it idempotent; a failure here surfaces (the route wraps it) rather than
  // silently orphaning the workspace.
  await sql/*sql*/`
    INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at, activated_by)
    VALUES (${newId}, ${ownerUserId}, 'owner', 'active', now(), ${ownerUserId})
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `;
  // P5(a) §5e: keep the entitlement + operating-mode axes in lockstep with the new membership (degrade-safe).
  await ensureMemberAuthorityProvisioned(sql, { userId: ownerUserId, workspaceId: newId, role: 'owner', actorUserId: ownerUserId });
  return rows[0]!;
}

export async function listWorkspacesForOperatorRow(sql: Sql, ownerUserIds: UserId[]): Promise<WorkspaceRow[]> {
  const ids = (ownerUserIds || []).filter(Boolean);
  if (ids.length === 0) return [];
  // Stage 1 · land-on-real-work (COCKPIT_IA_AND_TENANCY.md §4). Carry a per-workspace
  // last_event_at recency signal (newest non-archived operation_events.occurred_at,
  // falling back to the workspace's own updated_at when it has no events yet) AND order
  // by it DESC so the most-recently-active workspace sorts first. This is the signal the
  // cockpit's resolve-current-workspace activityScore() already probes but that the list
  // previously never carried — closing the documented no-op. The archived-filter is
  // unchanged; the correlated subquery is owner-scoped via the workspace row it joins.
  const rows = await sql/*sql*/`
    SELECT w.id, w.name, w.owner_user_id, w.slug, w.config, w.created_at, w.updated_at,
      COALESCE(
        (SELECT max(occurred_at) FROM operation_events
          WHERE workspace_id = w.id AND archived_at IS NULL),
        w.updated_at
      ) AS last_event_at
    FROM workspaces w WHERE w.owner_user_id = ANY(${ids})
      AND COALESCE((w.config->>'archived')::boolean, false) = false
    ORDER BY last_event_at DESC NULLS LAST
  ` as Array<WorkspaceRow>;
  return rows;
}

export async function updateWorkspaceRow(
  sql: Sql,
  id: WorkspaceId,
  patch: { name?: string; config?: Record<string, any> },
  ownerUserIds: UserId[],
): Promise<WorkspaceRow | null> {
  const ids = (ownerUserIds || []).filter(Boolean);
  if (!id || ids.length === 0) return null;
  const name = (typeof patch?.name === 'string' && patch.name.trim()) ? patch.name.trim().slice(0, 200) : null;
  const cfg = (patch?.config && typeof patch.config === 'object') ? patch.config : {};
  const rows = await sql/*sql*/`
    UPDATE workspaces
    SET name = COALESCE(${name}, name),
        config = COALESCE(config, '{}'::jsonb) || ${JSON.stringify(cfg)}::jsonb,
        updated_at = now()
    WHERE id = ${id} AND owner_user_id = ANY(${ids})
    RETURNING id, name, owner_user_id, slug, config, created_at, updated_at
  ` as Array<WorkspaceRow>;
  return rows[0] || null;
}
