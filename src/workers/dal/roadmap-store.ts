// roadmap-store.ts · synthetic-domain roadmap + roadmap-item group (R49' PR-3).
//
// Authority: DATABASE_SCHEMA_V1.md (synthetic_domain_roadmaps, synthetic_domain_roadmap_items,
// synthetic_domains, audit_logs) · API_CONTRACT_V1.md · AUTH_TENANCY_MODEL.md. Lifted verbatim out
// of WorkersDalAdapter (Stage 3.1, F10) to decompose the DAL god-object; behaviour is byte-for-byte
// identical to the prior inline methods.
//
// EXTRACTED here: createRoadmap, listRoadmapsForDomain, getRoadmap, updateRoadmap,
// updateRoadmapItem, deleteRoadmapItem, reorderRoadmapItems.
//
// NOT extracted — addRoadmapItem STAYS on the DAL: it is a SHARED helper. synthetic-domain-store
// and propagation-store each replicate addRoadmapItem (for their add_roadmap_item recommendation
// payload), so the canonical public method must remain on the class. normalizeRoadmapItemRow
// therefore also STAYS on the DAL (addRoadmapItem uses it); a byte-identical private copy lives
// here too (mirroring propagation-store) so this module has no back-reference to the class.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). Audit writes go
// through a private appendAuditLogRow mirroring WorkersDalAdapter.appendAuditLog exactly. The
// domain helpers getDomainOrThrowRow / updateDomainCountersRow mirror WorkersDalAdapter's private
// _getDomainOrThrow / _updateDomainCounters (which propagation-store already replicates) so
// createRoadmap/updateRoadmap stay independent of the class. These methods are NOT
// assertWorkspaceScope-guarded (the domain row carries the tenant binding; route layer enforces
// the owner/operator gate) — identical to the inline originals.

import { makeError } from './shared-helpers';
import type {
  UserId,
  AuditLogInput,
  SyntheticDomainId,
  SyntheticDomainRoadmap,
  SyntheticDomainRoadmapId,
  SyntheticDomainRoadmapItem,
  SyntheticDomainRoadmapItemId,
  SyntheticDomainRoadmapCreateInput,
  RoadmapStatus,
  RoadmapItemStatus,
} from './types';
import type { Sql } from '../db/client';

// ------------------------------------------------------------
// Internal helpers (lifted verbatim from WorkersDalAdapter)
// ------------------------------------------------------------

/** Mirrors WorkersDalAdapter.appendAuditLog INSERT exactly so audit rows are identical. */
async function appendAuditLogRow(sql: Sql, entry: AuditLogInput): Promise<void> {
  await sql/*sql*/`
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, metadata)
    VALUES (
      ${entry.actor_user_id},
      ${entry.action}::text,
      ${entry.target_type}::text,
      ${entry.target_id},
      ${entry.workspace_id ?? null},
      ${entry.reason ?? null},
      ${JSON.stringify(entry.metadata ?? {})}::jsonb
    )
  `;
}

/** Mirrors WorkersDalAdapter._getDomainOrThrow (shared with addRoadmapItem on the DAL). */
async function getDomainOrThrowRow(
  sql: Sql,
  domainId: SyntheticDomainId,
): Promise<{ id: string; workspace_id: string | null }> {
  const rows = await sql/*sql*/`
    SELECT id, workspace_id FROM synthetic_domains WHERE id = ${domainId} LIMIT 1
  ` as Array<{ id: string; workspace_id: string | null }>;
  if (rows.length === 0) throw makeError('NOT_FOUND', `synthetic_domain ${domainId} not found`, 404);
  return rows[0]!;
}

/**
 * Mirrors WorkersDalAdapter._updateDomainCounters (shared family).
 * Maintains synthetic_domains.has_roadmap + goal_count counters. Idempotent.
 */
async function updateDomainCountersRow(sql: Sql, domainId: SyntheticDomainId): Promise<void> {
  await sql/*sql*/`
    UPDATE synthetic_domains
    SET has_roadmap = (SELECT EXISTS (
          SELECT 1 FROM synthetic_domain_roadmaps
          WHERE domain_id = ${domainId} AND status NOT IN ('archived')
        )),
        goal_count = (SELECT COUNT(*)::int FROM synthetic_domain_goals
          WHERE domain_id = ${domainId} AND status IN ('proposed','active')),
        updated_at = now()
    WHERE id = ${domainId}
  `;
}

function normalizeRoadmapRow(r: SyntheticDomainRoadmap): SyntheticDomainRoadmap {
  return {
    ...r,
    description: r.description ?? null,
    target_date: r.target_date ?? null,
    metadata: r.metadata ?? {},
    updated_by: r.updated_by ?? null,
  };
}

/** Mirrors WorkersDalAdapter.normalizeRoadmapItemRow exactly (kept on the DAL too — shared family). */
function normalizeRoadmapItemRow(i: SyntheticDomainRoadmapItem): SyntheticDomainRoadmapItem {
  return {
    ...i,
    description: i.description ?? null,
    target_date: i.target_date ?? null,
    derived_from_project_id: i.derived_from_project_id ?? null,
    derived_from_event_id: i.derived_from_event_id ?? null,
    metadata: i.metadata ?? {},
  };
}

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function createRoadmapRow(sql: Sql, input: SyntheticDomainRoadmapCreateInput, actorUserId: UserId): Promise<SyntheticDomainRoadmap> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!input.title || input.title.length > 200) throw makeError('VALIDATION_ERROR', 'title 1-200 chars required', 400);
  const domain = await getDomainOrThrowRow(sql, input.domain_id);
  const newId = input.id && input.id.length > 0
    ? input.id
    : `sdr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const rows = await sql/*sql*/`
    INSERT INTO synthetic_domain_roadmaps (
      id, domain_id, workspace_id, title, description, target_date, status, version, metadata, created_by
    ) VALUES (
      ${newId},
      ${input.domain_id},
      ${domain.workspace_id},
      ${input.title},
      ${input.description ?? null},
      ${input.target_date ?? null},
      ${input.status ?? 'draft'},
      1,
      ${JSON.stringify(input.metadata ?? {})}::jsonb,
      ${actorUserId}
    )
    RETURNING id, domain_id, workspace_id, title, description, target_date, status,
              version, metadata, created_by, updated_by, created_at, updated_at
  ` as SyntheticDomainRoadmap[];
  const roadmap = normalizeRoadmapRow(rows[0]!);
  await updateDomainCountersRow(sql, input.domain_id);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_roadmap_create',
    target_type: 'synthetic_domain_roadmap',
    target_id: roadmap.id,
    workspace_id: roadmap.workspace_id ?? null,
    metadata: { domain_id: roadmap.domain_id, title: roadmap.title },
  });
  return roadmap;
}

export async function listRoadmapsForDomainRow(sql: Sql, domainId: SyntheticDomainId, status?: RoadmapStatus): Promise<SyntheticDomainRoadmap[]> {
  if (status) {
    const rows = await sql/*sql*/`
      SELECT id, domain_id, workspace_id, title, description, target_date, status,
             version, metadata, created_by, updated_by, created_at, updated_at
      FROM synthetic_domain_roadmaps
      WHERE domain_id = ${domainId} AND status = ${status}
      ORDER BY created_at DESC LIMIT 200
    ` as SyntheticDomainRoadmap[];
    return rows.map(normalizeRoadmapRow);
  }
  const rows = await sql/*sql*/`
    SELECT id, domain_id, workspace_id, title, description, target_date, status,
           version, metadata, created_by, updated_by, created_at, updated_at
    FROM synthetic_domain_roadmaps
    WHERE domain_id = ${domainId} AND status != 'archived'
    ORDER BY created_at DESC LIMIT 200
  ` as SyntheticDomainRoadmap[];
  return rows.map(normalizeRoadmapRow);
}

export async function getRoadmapRow(sql: Sql, roadmapId: SyntheticDomainRoadmapId): Promise<{ roadmap: SyntheticDomainRoadmap; items: SyntheticDomainRoadmapItem[] } | null> {
  const rRows = await sql/*sql*/`
    SELECT id, domain_id, workspace_id, title, description, target_date, status,
           version, metadata, created_by, updated_by, created_at, updated_at
    FROM synthetic_domain_roadmaps WHERE id = ${roadmapId} LIMIT 1
  ` as SyntheticDomainRoadmap[];
  if (rRows.length === 0) return null;
  const iRows = await sql/*sql*/`
    SELECT id, roadmap_id, domain_id, position, title, description, status, target_date,
           derived_from_project_id, derived_from_event_id, metadata, created_at, updated_at
    FROM synthetic_domain_roadmap_items
    WHERE roadmap_id = ${roadmapId} AND deleted_at IS NULL
    ORDER BY position ASC
  ` as SyntheticDomainRoadmapItem[];
  return {
    roadmap: normalizeRoadmapRow(rRows[0]!),
    items: iRows.map(normalizeRoadmapItemRow),
  };
}

export async function updateRoadmapRow(
  sql: Sql,
  roadmapId: SyntheticDomainRoadmapId,
  patch: { title?: string; description?: string | null; target_date?: string | null; status?: RoadmapStatus; metadata?: Record<string, any> },
  actorUserId: UserId,
): Promise<SyntheticDomainRoadmap> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  const rows = await sql/*sql*/`
    UPDATE synthetic_domain_roadmaps
    SET title = COALESCE(${patch.title ?? null}, title),
        description = COALESCE(${patch.description ?? null}, description),
        target_date = COALESCE(${patch.target_date ?? null}, target_date),
        status = COALESCE(${patch.status ?? null}, status),
        metadata = COALESCE(${patch.metadata ? JSON.stringify(patch.metadata) : null}::jsonb, metadata),
        version = version + 1,
        updated_by = ${actorUserId},
        updated_at = now()
    WHERE id = ${roadmapId}
    RETURNING id, domain_id, workspace_id, title, description, target_date, status,
              version, metadata, created_by, updated_by, created_at, updated_at
  ` as SyntheticDomainRoadmap[];
  if (rows.length === 0) throw makeError('NOT_FOUND', `roadmap ${roadmapId} not found`, 404);
  const roadmap = normalizeRoadmapRow(rows[0]!);
  if (patch.status === 'archived') {
    await updateDomainCountersRow(sql, roadmap.domain_id);
  }
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: patch.status === 'archived' ? 'sd_roadmap_archive' : 'sd_roadmap_update',
    target_type: 'synthetic_domain_roadmap',
    target_id: roadmap.id,
    workspace_id: roadmap.workspace_id ?? null,
    metadata: { changed_fields: Object.keys(patch) },
  });
  return roadmap;
}

export async function updateRoadmapItemRow(
  sql: Sql,
  itemId: SyntheticDomainRoadmapItemId,
  patch: { title?: string; description?: string | null; status?: RoadmapItemStatus; target_date?: string | null; metadata?: Record<string, any> },
  actorUserId: UserId,
): Promise<SyntheticDomainRoadmapItem> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  const rows = await sql/*sql*/`
    UPDATE synthetic_domain_roadmap_items
    SET title = COALESCE(${patch.title ?? null}, title),
        description = COALESCE(${patch.description ?? null}, description),
        status = COALESCE(${patch.status ?? null}, status),
        target_date = COALESCE(${patch.target_date ?? null}, target_date),
        metadata = COALESCE(${patch.metadata ? JSON.stringify(patch.metadata) : null}::jsonb, metadata),
        updated_at = now()
    WHERE id = ${itemId}
    RETURNING id, roadmap_id, domain_id, position, title, description, status, target_date,
              derived_from_project_id, derived_from_event_id, metadata, created_at, updated_at
  ` as SyntheticDomainRoadmapItem[];
  if (rows.length === 0) throw makeError('NOT_FOUND', `roadmap item ${itemId} not found`, 404);
  const item = normalizeRoadmapItemRow(rows[0]!);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_roadmap_item_update',
    target_type: 'synthetic_domain_roadmap_item',
    target_id: item.id,
    workspace_id: null,
    metadata: { changed_fields: Object.keys(patch) },
  });
  return item;
}

export async function deleteRoadmapItemRow(sql: Sql, itemId: SyntheticDomainRoadmapItemId, actorUserId: UserId): Promise<void> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  // 044 · SOFT delete: mark deleted_at so the customer planning artifact is recoverable. Reads filter
  // `deleted_at IS NULL`; the position re-pack below only ranks the remaining active items.
  const rows = await sql/*sql*/`
    UPDATE synthetic_domain_roadmap_items SET deleted_at = now(), updated_at = now()
    WHERE id = ${itemId} AND deleted_at IS NULL
    RETURNING id, roadmap_id, domain_id
  ` as Array<{ id: string; roadmap_id: string; domain_id: string }>;
  if (rows.length === 0) throw makeError('NOT_FOUND', `roadmap item ${itemId} not found`, 404);
  // Re-pack positions to remove gaps (active items only)
  const r = rows[0]!;
  await sql/*sql*/`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY position) - 1 AS new_pos
      FROM synthetic_domain_roadmap_items
      WHERE roadmap_id = ${r.roadmap_id} AND deleted_at IS NULL
    )
    UPDATE synthetic_domain_roadmap_items i
    SET position = ranked.new_pos
    FROM ranked
    WHERE i.id = ranked.id
  `;
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_roadmap_item_delete',
    target_type: 'synthetic_domain_roadmap_item',
    target_id: itemId,
    workspace_id: null,
    metadata: { roadmap_id: r.roadmap_id },
  });
}

// 044 · restore a soft-deleted roadmap item. Clears deleted_at and reassigns a fresh TAIL position
// (its old slot was re-packed away, so returning it there could collide with the partial-unique index).
export async function restoreRoadmapItemRow(sql: Sql, itemId: SyntheticDomainRoadmapItemId, actorUserId: UserId): Promise<SyntheticDomainRoadmapItem> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  const rows = await sql/*sql*/`
    UPDATE synthetic_domain_roadmap_items SET
      deleted_at = NULL,
      position = COALESCE((
        SELECT MAX(position) + 1 FROM synthetic_domain_roadmap_items sib
        WHERE sib.roadmap_id = synthetic_domain_roadmap_items.roadmap_id AND sib.deleted_at IS NULL
      ), 0),
      updated_at = now()
    WHERE id = ${itemId} AND deleted_at IS NOT NULL
    RETURNING id, roadmap_id, domain_id, position, title, description, status, target_date,
              derived_from_project_id, derived_from_event_id, metadata, created_at, updated_at
  ` as SyntheticDomainRoadmapItem[];
  if (rows.length === 0) throw makeError('NOT_FOUND', `deleted roadmap item ${itemId} not found`, 404);
  const item = normalizeRoadmapItemRow(rows[0]!);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_roadmap_item_restore',
    target_type: 'synthetic_domain_roadmap_item',
    target_id: item.id,
    workspace_id: null,
    metadata: { roadmap_id: item.roadmap_id },
  });
  return item;
}

export async function reorderRoadmapItemsRow(
  sql: Sql,
  roadmapId: SyntheticDomainRoadmapId,
  itemIdsInOrder: SyntheticDomainRoadmapItemId[],
  actorUserId: UserId,
): Promise<SyntheticDomainRoadmapItem[]> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!Array.isArray(itemIdsInOrder)) throw makeError('VALIDATION_ERROR', 'itemIdsInOrder must be an array', 400);
  // Two-step: move all to negative positions first (avoid unique constraint conflict), then set final positions
  if (itemIdsInOrder.length > 0) {
    await sql/*sql*/`
      UPDATE synthetic_domain_roadmap_items
      SET position = -1 - position
      WHERE roadmap_id = ${roadmapId} AND id = ANY(${itemIdsInOrder}::text[])
    `;
    const positions = itemIdsInOrder.map((_, i) => i);
    await sql/*sql*/`
      UPDATE synthetic_domain_roadmap_items i
      SET position = t.new_pos, updated_at = now()
      FROM unnest(${itemIdsInOrder}::text[], ${positions}::int[]) AS t(item_id, new_pos)
      WHERE i.id = t.item_id AND i.roadmap_id = ${roadmapId}
    `;
  }
  const rows = await sql/*sql*/`
    SELECT id, roadmap_id, domain_id, position, title, description, status, target_date,
           derived_from_project_id, derived_from_event_id, metadata, created_at, updated_at
    FROM synthetic_domain_roadmap_items
    WHERE roadmap_id = ${roadmapId} AND deleted_at IS NULL
    ORDER BY position ASC
  ` as SyntheticDomainRoadmapItem[];
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_roadmap_item_reorder',
    target_type: 'synthetic_domain_roadmap',
    target_id: roadmapId,
    workspace_id: null,
    metadata: { item_count: itemIdsInOrder.length },
  });
  return rows.map(normalizeRoadmapItemRow);
}

// ── OS-4 P2 · the workspace Plan aggregate ───────────────────────────────────────────────────────
//
// The operator's "we don't see roadmaps, goals" gap: full planning DAL existed but the ONLY render
// was 4 levels deep in SyntheticDomainsPanel. This is the ONE read the new ?screen=plan surface
// calls: every domain visible from a workspace (its own + cross-workspace lenses, the same
// visibility rule the data-graph lens nodes use) with its roadmaps (+ item progress rollup) and
// goals (+ current/target), in THREE bounded queries (no per-domain N+1). Read-only; reuses the
// existing planning tables (HR-NO-PARALLEL-MODEL-1 — no new model).

export interface WorkspacePlanRoadmap {
  id: string; domain_id: string; title: string; status: string;
  items_total: number; items_done: number; updated_at: string;
  // ABS-P2: ordered child-item titles so the read model can flatten to lines at the presentation
  // boundary (mig 068 folds the flattened rows into roadmap+items). Empty when a roadmap has no items.
  item_titles: string[];
}
export interface WorkspacePlanGoalRelationship { to_goal_id: string; kind: string; }
export interface WorkspacePlanGoal {
  id: string; domain_id: string; title: string; status: string;
  metric_name: string | null; metric_unit: string | null;
  target_value: number | null; current_value: number | null; updated_at: string;
  // SE-1 SMART-ER layer (mig 069). All nullable — a goal without the -ER contract renders as
  // before (title + spine); the adapter/design surface these when present (SE-3).
  tier: string | null; ikigai_axes: string[]; future_state: string | null;
  review_cadence: string | null; review_due: string | null; source_goal_id: string | null;
  goal_metric_contract: Record<string, unknown> | null;
  relationships: WorkspacePlanGoalRelationship[];
}
export interface WorkspacePlanDomain {
  id: string; label: string; workspace_id: string | null;
  roadmaps: WorkspacePlanRoadmap[]; goals: WorkspacePlanGoal[];
}

export async function listWorkspacePlanRow(sql: Sql, workspaceId: string): Promise<{ domains: WorkspacePlanDomain[] }> {
  // (1) domains visible from this workspace: its own + cross-workspace lenses (workspace_id IS NULL),
  // mirroring the lens-node visibility in graph/data-graph.ts. Archived domains are excluded.
  const domains = (await sql/*sql*/`
    SELECT id, label, workspace_id FROM synthetic_domains
    WHERE (workspace_id = ${workspaceId} OR workspace_id IS NULL)
      AND COALESCE(status, 'active') != 'archived'
    ORDER BY label ASC LIMIT 200
  `) as Array<{ id: string; label: string; workspace_id: string | null }>;
  if (domains.length === 0) return { domains: [] };
  const ids = domains.map((d) => d.id);

  // (2) roadmaps + item-progress rollup in ONE query (LEFT JOIN aggregate — no per-roadmap fetch).
  const roadmaps = (await sql/*sql*/`
    SELECT r.id, r.domain_id, r.title, r.status, r.updated_at,
           COUNT(i.id)::int AS items_total,
           COUNT(i.id) FILTER (WHERE i.status IN ('done', 'completed'))::int AS items_done,
           COALESCE(
             array_agg(i.title ORDER BY i.position) FILTER (WHERE i.id IS NOT NULL AND i.deleted_at IS NULL),
             ARRAY[]::text[]
           ) AS item_titles
    FROM synthetic_domain_roadmaps r
    LEFT JOIN synthetic_domain_roadmap_items i ON i.roadmap_id = r.id
    WHERE r.domain_id = ANY(${ids}) AND r.status != 'archived'
    GROUP BY r.id, r.domain_id, r.title, r.status, r.updated_at
    ORDER BY r.updated_at DESC LIMIT 500
  `) as unknown as WorkspacePlanRoadmap[];

  // (3) goals with live current/target values + the SE-1 SMART-ER layer (mig 069) and reinforces/
  // conflicts relationships (LEFT JOIN aggregate; empty array when a goal has no -ER contract/edges).
  const goals = (await sql/*sql*/`
    SELECT g.id, g.domain_id, g.title, g.status, g.metric_name, g.metric_unit,
           g.target_value::float AS target_value, g.current_value::float AS current_value, g.updated_at,
           g.tier, g.ikigai_axes, g.future_state, g.review_cadence, g.review_due::text AS review_due,
           g.source_goal_id, g.goal_metric_contract,
           COALESCE(
             json_agg(json_build_object('to_goal_id', rel.to_goal_id, 'kind', rel.kind))
               FILTER (WHERE rel.id IS NOT NULL),
             '[]'::json
           ) AS relationships
    FROM synthetic_domain_goals g
    LEFT JOIN synthetic_domain_goal_relationships rel ON rel.from_goal_id = g.id
    WHERE g.domain_id = ANY(${ids}) AND g.status != 'archived'
    GROUP BY g.id, g.domain_id, g.title, g.status, g.metric_name, g.metric_unit,
             g.target_value, g.current_value, g.updated_at, g.tier, g.ikigai_axes, g.future_state,
             g.review_cadence, g.review_due, g.source_goal_id, g.goal_metric_contract
    ORDER BY g.updated_at DESC LIMIT 500
  `) as unknown as WorkspacePlanGoal[];

  const byDomain: Record<string, WorkspacePlanDomain> = {};
  for (const d of domains) byDomain[d.id] = { ...d, roadmaps: [], goals: [] };
  for (const r of roadmaps) byDomain[r.domain_id]?.roadmaps.push(r);
  for (const g of goals) byDomain[g.domain_id]?.goals.push(g);
  // Domains with NO plan data are still returned (honest empty state — the surface shows them muted
  // with a "plan in the domain panel" affordance, never hidden).
  return { domains: Object.values(byDomain) };
}
