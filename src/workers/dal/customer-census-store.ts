// customer-census-store.ts · J-E TASK 2 (260719) · raw-SQL primitives for the tenant-plane sterility census.
//
// Authority: crons/customer-census.ts (the OBSERVE-only loop chained into the daily 05:00 slot) + the pure
// math in lib/customer-census.ts. These are the ONLY DB-touching parts of the loop. They are bound into the
// cron context as a gateway (crons/types.ts CustomerCensusGateway) rather than added to the FROZEN
// WorkersDalAdapter facade (S-R1 ceiling) — the SAME pattern as the A10 reviewSchedule gateway.
//
// SAFETY / SCOPE:
//   - The census is BORN-OFF (CUSTOMER_CENSUS_ENABLED unset ⇒ the cron never calls these) — nothing here
//     executes until an operator flips the flag AND has applied migration 083.
//   - Every read/write is workspace-scoped. The observation row is customer-safe: counts + hashes ONLY,
//     NO work ids / titles / content (mirrors mig 077 current_work_parity_observations).
//   - OBSERVE-only: there is no UPDATE/DELETE of tenant data here. reclassify_unattributed is the sole
//     remediation arm.
//
// NOTE: this file may reference the DB directly only because it lives in the DAL layer, same as the other
// *-store.ts files. The cron + pure tests never import it; they go through the injected gateway.

import type { Sql } from '../db/client';

/** The customer-safe census observation row (mig 083). Counts + hashes only — never a work id/title. */
export interface CustomerCensusObservationInsert {
  id: string;
  workspace_id: string;
  run_id: string;
  population_events: number;
  population_intents: number;
  population_documents: number;
  population_total: number;
  governed_attributed_events: number;
  governed_lineage_edges: number;
  governed_intake_resolutions: number;
  governed_total: number;
  orphan_unattributed_events: number;
  orphan_dangling_intents: number;
  orphan_effect_nodes_without_cause: number;
  orphan_missing_source_bindings: number;
  orphan_total: number;
  orphan_set_hash: string;
  graph_hash: string;
}

/**
 * Bounded, deterministic enumeration of workspace ids the census observes. Ordered by id so a run always
 * covers the same prefix when the count exceeds the cap (our scale is low tens of workspaces; the cap is a
 * safety ceiling, not paging). Returns [] on an empty estate.
 */
export async function listWorkspaceIdsForCensusRow(sql: Sql, limit: number): Promise<string[]> {
  const cappedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 0, 1000));
  const rows = (await sql/*sql*/`
    SELECT id FROM workspaces ORDER BY id LIMIT ${cappedLimit}
  `) as Array<{ id: string }>;
  return rows.map((r) => String(r.id)).filter(Boolean);
}

/**
 * Count governed intake_resolutions (mig 079/075) for one workspace — the "closed via single-intake" arm of
 * the governed measure. Tenant-scoped. Returns 0 for a workspace with none.
 */
export async function countIntakeResolutionsRow(sql: Sql, workspaceId: string): Promise<number> {
  const ws = String(workspaceId || '');
  if (!ws) return 0;
  const rows = (await sql/*sql*/`
    SELECT count(*)::int AS n FROM intake_resolutions WHERE workspace_id = ${ws}
  `) as Array<{ n: number }>;
  return rows.length ? Number(rows[0].n) || 0 : 0;
}

/**
 * Persist ONE workspace's census observation (mig 083). Append-only: each run inserts a fresh row so the
 * orphan-delta trend is a time series (idx_customer_census_workspace on (workspace_id, created_at DESC)).
 * created_at defaults to now() in the DDL. No ON CONFLICT: ids are per-run unique.
 */
export async function recordCustomerCensusObservationRow(sql: Sql, row: CustomerCensusObservationInsert): Promise<void> {
  await sql/*sql*/`
    INSERT INTO customer_census_observations (
      id, workspace_id, run_id,
      population_events, population_intents, population_documents, population_total,
      governed_attributed_events, governed_lineage_edges, governed_intake_resolutions, governed_total,
      orphan_unattributed_events, orphan_dangling_intents, orphan_effect_nodes_without_cause,
      orphan_missing_source_bindings, orphan_total,
      orphan_set_hash, graph_hash
    ) VALUES (
      ${row.id}, ${row.workspace_id}, ${row.run_id},
      ${row.population_events}, ${row.population_intents}, ${row.population_documents}, ${row.population_total},
      ${row.governed_attributed_events}, ${row.governed_lineage_edges}, ${row.governed_intake_resolutions}, ${row.governed_total},
      ${row.orphan_unattributed_events}, ${row.orphan_dangling_intents}, ${row.orphan_effect_nodes_without_cause},
      ${row.orphan_missing_source_bindings}, ${row.orphan_total},
      ${row.orphan_set_hash}, ${row.graph_hash}
    )
  `;
}
