// plan-store.ts · G1 (260711) · customer plan_entities CRUD (goal/milestone/todo/intent).
//
// Authority: src/workers/db/migrations/066_plan_entities.sql · BACKEND-CONVERGENCE-BUILDLIST-260711 §G1.
//
// One customer-scoped table backs the whole plan facade. WORKSPACE-scoped (the route enforces the
// member + role!='client' gate; every read/write here filters by workspace_id as a second layer, and
// the 066 RLS policy is a third). Position handling mirrors roadmap-store: a soft delete or a reorder
// re-packs the sibling set sharing the same parent_id so positions stay gap-free (ROW_NUMBER re-rank,
// 044 partial-unique semantics). NO audit_logs rows are appended: audit_logs.target_type carries a
// CHECK allowlist that has no plan value, so writing one would need a CHECK-widening migration the G1
// scope does not include — provenance is captured by created_by/updated_by + created_at/updated_at on
// the row itself (the customer-recoverable soft-delete keeps deleted rows too).

import { makeError, randomNanoid } from './shared-helpers';
import type {
  PlanEntity,
  PlanEntityCreateInput,
  PlanEntityKind,
  PlanEntityPatch,
  PlanEntityId,
  PlanEntityListContext,
  PlanEntityDeleteReceipt,
  UserId,
  WorkspaceId,
} from './types';
import type { Sql } from '../db/client';

const VALID_KINDS: ReadonlySet<PlanEntityKind> = new Set(['goal', 'milestone', 'todo', 'intent']);

// Disjoint high range used by the reorder re-pack so a bulk re-number never transiently collides with a
// still-occupied position under the partial-unique(parent_id, position) index (two-phase shift).
const REPACK_OFFSET = 1_000_000;

// ------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPlanEntity(r: any): PlanEntity {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    scope_id: r.scope_id ?? null,
    scope_type: r.scope_type ?? null,
    parent_id: r.parent_id ?? null,
    kind: r.kind ?? null,
    title: r.title,
    summary: r.summary ?? null,
    status: r.status ?? 'open',
    position: typeof r.position === 'number' ? r.position : Number(r.position ?? 0),
    target_date: toIso(r.target_date),
    derived_from: r.derived_from ?? null,
    promoted_to_intent_id: r.promoted_to_intent_id ?? null,
    created_by: r.created_by ?? null,
    updated_by: r.updated_by ?? null,
    created_at: toIso(r.created_at) ?? '',
    updated_at: toIso(r.updated_at) ?? '',
  };
}

/** Re-pack the active sibling set sharing (workspace_id, scope_id, parent_id) to gap-free 0..n-1.
 *  Two-phase (offset then subtract) so it is collision-safe even when positions move UP (a reorder can
 *  push an item onto a slot another row still holds). `pinnedFirstId` wins ties at the same integer
 *  position so a "move to position N" lands the moved row AT N and pushes the prior occupant down. */
async function repackSiblings(
  sql: Sql,
  workspaceId: WorkspaceId,
  scopeId: string | null,
  parentId: PlanEntityId | null,
  pinnedFirstId: PlanEntityId | null,
): Promise<void> {
  await sql/*sql*/`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
               ORDER BY position ASC,
                        (CASE WHEN id = ${pinnedFirstId}::text THEN 0 ELSE 1 END) ASC,
                        updated_at ASC, id ASC
             ) - 1 AS new_pos
      FROM plan_entities
      WHERE workspace_id = ${workspaceId}
        AND scope_id IS NOT DISTINCT FROM ${scopeId}::text
        AND parent_id IS NOT DISTINCT FROM ${parentId}::text
        AND deleted_at IS NULL
    )
    UPDATE plan_entities e SET position = ranked.new_pos + ${REPACK_OFFSET}
    FROM ranked WHERE e.id = ranked.id
  `;
  await sql/*sql*/`
    UPDATE plan_entities SET position = position - ${REPACK_OFFSET}
    WHERE workspace_id = ${workspaceId}
      AND scope_id IS NOT DISTINCT FROM ${scopeId}::text
      AND parent_id IS NOT DISTINCT FROM ${parentId}::text
      AND deleted_at IS NULL
      AND position >= ${REPACK_OFFSET}
  `;
}

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function createPlanEntityRow(
  sql: Sql,
  input: PlanEntityCreateInput,
  actorUserId: UserId,
): Promise<PlanEntity> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!input.workspace_id) throw makeError('VALIDATION_ERROR', 'workspace_id required', 400);
  if (!input.title || input.title.length > 200) throw makeError('VALIDATION_ERROR', 'title 1-200 chars required', 400);
  if (!VALID_KINDS.has(input.kind)) throw makeError('VALIDATION_ERROR', `kind must be one of: ${Array.from(VALID_KINDS).join(', ')}`, 400);

  const id = `ple_${randomNanoid()}`;
  const scopeId = input.scope_id ?? null;
  const parentId = input.parent_id ?? null;
  // INSERT ... SELECT so the tail position is computed from the CURRENT active sibling set in one round-trip.
  const rows = (await sql/*sql*/`
    INSERT INTO plan_entities (
      id, workspace_id, scope_id, scope_type, parent_id, kind, title, summary, status, position,
      target_date, created_by, updated_by
    )
    SELECT
      ${id}, ${input.workspace_id}, ${scopeId}::text, ${input.scope_type ?? null}::text,
      ${parentId}::text, ${input.kind}, ${input.title}, ${input.summary ?? null}, 'open',
      COALESCE((
        SELECT MAX(position) + 1 FROM plan_entities p
        WHERE p.workspace_id = ${input.workspace_id}
          AND p.scope_id IS NOT DISTINCT FROM ${scopeId}::text
          AND p.parent_id IS NOT DISTINCT FROM ${parentId}::text
          AND p.deleted_at IS NULL
      ), 0),
      ${input.target_date ?? null}::date, ${actorUserId}, ${actorUserId}
    RETURNING id, workspace_id, scope_id, scope_type, parent_id, kind, title, summary, status,
              position, target_date, derived_from, promoted_to_intent_id, created_by, updated_by,
              created_at, updated_at
  `) as Record<string, unknown>[];
  if (!rows[0]) throw makeError('INTERNAL_ERROR', 'plan entity insert produced no row', 500);
  return rowToPlanEntity(rows[0]);
}

export async function listPlanEntitiesRow(
  sql: Sql,
  scopeId: string,
  ctx: PlanEntityListContext,
): Promise<PlanEntity[]> {
  if (!ctx?.workspaceId) throw makeError('UNAUTHORIZED', 'workspace scope required', 401);
  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, scope_id, scope_type, parent_id, kind, title, summary, status,
           position, target_date, derived_from, promoted_to_intent_id, created_by, updated_by,
           created_at, updated_at
    FROM plan_entities
    WHERE workspace_id = ${ctx.workspaceId} AND scope_id IS NOT DISTINCT FROM ${scopeId}::text
      AND deleted_at IS NULL
    ORDER BY position ASC, created_at ASC
    LIMIT 500
  `) as Record<string, unknown>[];
  return rows.map(rowToPlanEntity);
}

/** Workspace-scoped single read — the route uses it for the tenancy 404 before a PATCH/DELETE
 *  (mirrors sources.ts getUserSource → 404). Returns null for a missing OR cross-tenant id. */
export async function getPlanEntityRow(
  sql: Sql,
  id: PlanEntityId,
  workspaceId: WorkspaceId,
): Promise<PlanEntity | null> {
  if (!id || !workspaceId) return null;
  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, scope_id, scope_type, parent_id, kind, title, summary, status,
           position, target_date, derived_from, promoted_to_intent_id, created_by, updated_by,
           created_at, updated_at
    FROM plan_entities
    WHERE id = ${id} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows[0] ? rowToPlanEntity(rows[0]) : null;
}

export async function updatePlanEntityRow(
  sql: Sql,
  id: PlanEntityId,
  patch: PlanEntityPatch,
  actorUserId: UserId,
): Promise<PlanEntity> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (patch.title !== undefined && (!patch.title || patch.title.length > 200)) {
    throw makeError('VALIDATION_ERROR', 'title 1-200 chars required', 400);
  }
  const parentProvided = Object.prototype.hasOwnProperty.call(patch, 'parent_id');
  const rows = (await sql/*sql*/`
    UPDATE plan_entities SET
      title = COALESCE(${patch.title ?? null}, title),
      status = COALESCE(${patch.status ?? null}, status),
      position = COALESCE(${patch.position ?? null}, position),
      parent_id = CASE WHEN ${parentProvided}::boolean THEN ${patch.parent_id ?? null}::text ELSE parent_id END,
      updated_by = ${actorUserId},
      updated_at = now()
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id, workspace_id, scope_id, scope_type, parent_id, kind, title, summary, status,
              position, target_date, derived_from, promoted_to_intent_id, created_by, updated_by,
              created_at, updated_at
  `) as Record<string, unknown>[];
  if (!rows[0]) throw makeError('NOT_FOUND', `plan entity ${id} not found`, 404);
  const updated = rowToPlanEntity(rows[0]);

  // A position or parent move re-packs the (new) sibling set so ordering stays gap-free; the moved row
  // is pinned first at ties so it lands AT the requested slot. No move ⇒ return the row as written.
  if (patch.position !== undefined || parentProvided) {
    await repackSiblings(sql, updated.workspace_id, updated.scope_id, updated.parent_id, updated.id);
    const refreshed = await getPlanEntityRow(sql, id, updated.workspace_id);
    return refreshed ?? updated;
  }
  return updated;
}

export async function softDeletePlanEntityRow(
  sql: Sql,
  id: PlanEntityId,
  actorUserId: UserId,
): Promise<PlanEntityDeleteReceipt> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  // SOFT delete (customer-recoverability doctrine): mark deleted_at so the plan artifact is recoverable.
  // Reads filter deleted_at IS NULL; the re-pack below closes the gap among the remaining active siblings.
  const rows = (await sql/*sql*/`
    UPDATE plan_entities SET deleted_at = now(), updated_at = now(), updated_by = ${actorUserId}
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id, workspace_id, scope_id, parent_id, updated_at
  `) as Array<{ id: string; workspace_id: string; scope_id: string | null; parent_id: string | null; updated_at: unknown }>;
  if (!rows[0]) throw makeError('NOT_FOUND', `plan entity ${id} not found`, 404);
  const r = rows[0];
  await repackSiblings(sql, r.workspace_id, r.scope_id ?? null, r.parent_id ?? null, null);
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    scope_id: r.scope_id ?? null,
    parent_id: r.parent_id ?? null,
    updated_at: toIso(r.updated_at) ?? '',
  };
}
