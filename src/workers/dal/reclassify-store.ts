// reclassify-store.ts · self-healing reclassification primitives.
//
// Authority: backstop to the going-forward producer (PR #517 ·
// routes/github-webhook.ts + lib/classify-body-of-work.ts). Where the producer
// classifies NEW events at ingest, this store backs the periodic cron that
// RE-FILES the unattributed backlog into the same 8 bodies-of-work projects —
// see crons/reclassify-unattributed.ts.
//
// These are raw-SQL primitives (the only DB-touching part of the loop). The cron
// is a pure function over these via the DAL, so it unit-tests with a DAL double
// exactly like the scheduled-digest-sweep cron (no live Neon needed).
//
// SAFETY / SCOPE:
//   - Split-enabled workspaces are detected via a project carrying
//     metadata->>'origin' = the split-origin marker, so a workspace that never
//     opted into the 8-project split is NEVER touched.
//   - An event is only re-filed when the target `${workspace_id}-<slug>` project
//     ROW EXISTS in that workspace — so the FK on operation_events.project_id is
//     always satisfied (no unknown-slug / missing-project FK error).
//   - Every UPDATE is tenant-scoped (workspace_id in the WHERE clause) and only
//     touches rows that are still unattributed at write time (idempotent).
//
// NOTE: this file may reference Neon directly only because it lives in the DAL
// layer (BACKEND_ROLE_DEFINITION.md §3 backend-agnostic seam), same as the other
// *-store.ts files. The cron + tests never import it; they go through the DAL.

import type { Sql } from '../db/client';

/**
 * The metadata->>'origin' marker the producer/provisioning stamps on each of the
 * 8 canonical bodies-of-work projects (`${ws}-{cockpit-ux,...,funnel}`). A
 * workspace is "split-enabled" iff it has ≥1 project with this origin. Keeping
 * the marker here (one place) means the cron's scope guard and the provisioning
 * step share a single source of truth.
 */
export const ALLACTIVITY_SPLIT_ORIGIN = 'allactivity_split_260609';

/** A single unattributed event the cron may re-file (just the fields it needs). */
export interface UnattributedEventRow {
  id: string;
  workspace_id: string;
  summary: string;
}

/**
 * Workspace ids that opted into the 8-project split — i.e. have ≥1 project whose
 * metadata->>'origin' = ALLACTIVITY_SPLIT_ORIGIN. Empty array when none.
 *
 * Scoping the whole loop to this set is what makes it FK-safe AND opt-in: a
 * workspace that never provisioned the 8 projects is invisible to the cron.
 */
export async function listSplitEnabledWorkspaceIdsRow(sql: Sql): Promise<string[]> {
  const rows = (await sql/*sql*/`
    SELECT DISTINCT workspace_id
    FROM projects
    WHERE metadata->>'origin' = ${ALLACTIVITY_SPLIT_ORIGIN}
  `) as Array<{ workspace_id: string }>;
  return rows.map((r) => String(r.workspace_id)).filter(Boolean);
}

/**
 * The unattributed backlog within the given split-enabled workspaces, bounded by
 * `limit`. "Unattributed" = project_id IS NULL OR project_id LIKE '%-allactivity'
 * (the catch-all bucket the events were dumped into pre-split). Newest first so a
 * draining backlog re-files the most-recent activity first.
 *
 * Returns [] when `workspaceIds` is empty (never runs an unscoped scan).
 */
export async function listUnattributedEventsRow(
  sql: Sql,
  workspaceIds: string[],
  limit: number,
): Promise<UnattributedEventRow[]> {
  const ids = (Array.isArray(workspaceIds) ? workspaceIds : []).filter(Boolean);
  if (ids.length === 0) return [];
  const cappedLimit = Math.max(1, Math.min(limit, 500));

  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, summary
    FROM operation_events
    WHERE workspace_id = ANY(${ids})
      AND archived_at IS NULL
      AND (project_id IS NULL OR project_id LIKE '%-allactivity')
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${cappedLimit}
  `) as Array<{ id: string; workspace_id: string; summary: string }>;

  return rows.map((r) => ({
    id: String(r.id),
    workspace_id: String(r.workspace_id),
    summary: String(r.summary ?? ''),
  }));
}

/**
 * The set of project ids that ACTUALLY EXIST within the given split-enabled
 * workspaces. The cron consults this before every UPDATE so it can skip any
 * `${ws}-<slug>` whose project row is missing — guaranteeing the FK on
 * operation_events.project_id is satisfied (no unknown-slug / missing-project
 * FK error). Returned as a plain string set for O(1) membership checks.
 */
export async function listProjectIdsForWorkspacesRow(
  sql: Sql,
  workspaceIds: string[],
): Promise<Set<string>> {
  const ids = (Array.isArray(workspaceIds) ? workspaceIds : []).filter(Boolean);
  if (ids.length === 0) return new Set<string>();

  const rows = (await sql/*sql*/`
    SELECT id FROM projects WHERE workspace_id = ANY(${ids})
  `) as Array<{ id: string }>;
  return new Set(rows.map((r) => String(r.id)));
}

/**
 * Re-file ONE event into its classified body-of-work project. Tenant-scoped
 * (workspace_id in the WHERE), and only touches rows that are STILL unattributed
 * at write time — so a concurrent producer write or a re-run is a safe no-op
 * (idempotent). The caller has already proven `projectId` exists in the
 * workspace, so the FK can't fire. Returns the number of rows updated (0 or 1).
 */
export async function reassignEventProjectRow(
  sql: Sql,
  workspaceId: string,
  eventId: string,
  projectId: string,
): Promise<number> {
  if (!workspaceId || !eventId || !projectId) return 0;
  const rows = (await sql/*sql*/`
    UPDATE operation_events
    SET project_id = ${projectId}
    WHERE workspace_id = ${workspaceId}
      AND id = ${eventId}
      AND (project_id IS NULL OR project_id LIKE '%-allactivity')
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length;
}
