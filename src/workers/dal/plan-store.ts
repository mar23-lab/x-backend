// plan-store.ts · workspace-scoped customer plan entity reads.
//
// Authority: src/workers/db/migrations/066_plan_entities.sql · BACKEND-CONVERGENCE-BUILDLIST-260711 §G1.
//
// Writes live only in plan-command-store/operations, where mutation, sibling ordering, replay,
// event, audit, and outbox are one authority transaction.

import { makeError } from './shared-helpers';
import type {
  PlanEntity,
  PlanEntityId,
  PlanEntityListContext,
  WorkspaceId,
} from './types';
import type { Sql } from '../db/client';

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

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

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
