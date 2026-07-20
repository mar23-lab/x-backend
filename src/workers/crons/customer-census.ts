// src/workers/crons/customer-census.ts · J-E TASK 2 (260719) · the OBSERVE-only tenant sterility census loop.
//
// MB-P runs a sterility census over its estate (git ls-files MINUS graph∪registry∪frontmatter). This is that
// census translated to the CUSTOMER / tenant plane, chained into the daily 05:00 slot
// (calibrationRetrainThenReviewThenShadowEvalThenCensus). Per workspace it measures population vs governed and
// records the orphan delta BY CLASS + a set hash — so the operator can watch each tenant's ungoverned surface
// as a trend, and route the orphan classes to their remediation arms.
//
// SAFETY POSTURE (identical ethos to reclassify-unattributed):
//   - BORN-OFF, DEFAULT OFF. CUSTOMER_CENSUS_ENABLED must be exactly "true" (case-insensitive). Anything else
//     ⇒ ZERO reads/writes — the loop is byte-inert (mirrors reclassify-unattributed.ts:69-79).
//   - OBSERVE-ONLY. It computes + persists; it NEVER remediates. reclassify_unattributed stays the only
//     remediation arm (a census that also fixes would conflate detection with action — the MB-P discipline
//     keeps the orphan LIST as a worklist for the remediation arm, not a silent auto-fix).
//   - NEVER THROWS at the batch level: a failing workspace is isolated + counted; the loop completes and
//     returns a structured summary (degraded when any workspace errored).
//   - REUSES the customer-safe walkers assembleDataGraphFacts + buildDataGraph (the SAME reads
//     customer-lineage.ts uses) — no new graph logic. All counting/orphan math is the PURE
//     computeWorkspaceCensus (lib/customer-census.ts), unit-tested in isolation.
//
// Persistence is customer-safe (mig 083, modelled on mig 077): counts + hashes only, NO work ids/titles.

import { nanoid } from 'nanoid';
import type { CronHandler, CronHandlerContext, CronHandlerResult } from './types';
import { envFlagTrue } from '../lib/env-flag';
import { buildDataGraph } from '../graph/data-graph';
import { DATA_GRAPH_FACTS_CAP } from '../dal/graph-store';
import { computeWorkspaceCensus } from '../lib/customer-census';
import type { CustomerCensusObservationInsert } from '../dal/customer-census-store';

const LOOP_NAME = 'customer_census';

/** Bounded per run (safety ceiling; our scale is low tens of workspaces). */
export const MAX_WORKSPACES = 500;

export const customerCensusCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const run_id = `census_${startedAt.toISOString()}`;

  // ── BORN-OFF: flag must be exactly "true" (case-insensitive) — else byte-inert ────────────────
  if (!envFlagTrue(ctx.env?.CUSTOMER_CENSUS_ENABLED)) {
    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: 0,
      cost_ms: ctx.now().getTime() - startedAt.getTime(),
      status: 'skipped',
      notes: 'flag_disabled · set CUSTOMER_CENSUS_ENABLED=true to enable',
      metadata: { loop: LOOP_NAME, reason: 'flag_disabled' },
    };
  }

  // The census gateway (workspace enumeration + intake_resolutions count + persistence) is injected by the
  // dispatcher. Absent ⇒ the loop cannot observe; skip rather than throw (dormant-safe in tests/runtimes
  // that don't bind it).
  const census = ctx.census;
  if (!census) {
    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: 0,
      cost_ms: ctx.now().getTime() - startedAt.getTime(),
      status: 'skipped',
      notes: 'census_gateway_unbound',
      metadata: { loop: LOOP_NAME, reason: 'census_gateway_unbound' },
    };
  }

  // Documents count toward population only when the graph tracks document nodes (same flag customer-lineage
  // honours). When off, documents=0 — an honest "not tracked", not a silent undercount.
  const includeDocuments = envFlagTrue(ctx.env?.GRAPH_DOCUMENT_NODES_ENABLED);

  let workspacesObserved = 0;
  let workspacesErrored = 0;
  let workspacesTruncated = 0;
  let totalOrphans = 0;
  let totalPopulation = 0;

  try {
    const workspaceIds = await census.listWorkspaceIds(MAX_WORKSPACES);
    if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) {
      return done(ctx, startedAt, run_id, { workspacesObserved: 0, workspacesErrored: 0, workspacesTruncated: 0, totalOrphans: 0, totalPopulation: 0, workspacesSeen: 0, notes: 'no workspaces' });
    }

    for (const ws of workspaceIds) {
      try {
        const facts = await ctx.dal.assembleDataGraphFacts(ws, { includeDocuments });

        // AI-EXEC-1 (260721): DETECT the facts-read cap truncation instead of hiding it. A workspace whose
        // unified event read returns exactly DATA_GRAPH_FACTS_CAP rows almost certainly had older rows
        // dropped ⇒ its population/orphan counts are UNDER-REPORTED for this observation. We surface it
        // (never silence it — the false-zero class this census exists to kill). The DURABLE fix at real
        // scale is pagination + a persisted population_capped column (a mig); deferred until a real tenant
        // approaches the cap (largest today ~4.2k, internal). Until then the run notes carry the warning.
        const capped = facts.unified.length >= DATA_GRAPH_FACTS_CAP;
        if (capped) {
          workspacesTruncated += 1;
          console.warn(JSON.stringify({
            kind: 'customer_census_truncated', loop: LOOP_NAME, run_id, workspace_id: ws,
            unified_rows: facts.unified.length, cap: DATA_GRAPH_FACTS_CAP,
          }));
        }

        const { nodes, edges, snapshot } = buildDataGraph(ws, facts);

        // intake_resolutions is a best-effort governed input: a missing table (mig 079 not applied) or a
        // read error degrades to 0 rather than failing the whole workspace census (which is graph-derived).
        let intakeResolutionCount = 0;
        try { intakeResolutionCount = await census.countIntakeResolutions(ws); }
        catch { intakeResolutionCount = 0; }

        const result = computeWorkspaceCensus({
          workspaceId: ws,
          facts,
          nodes,
          edges,
          graphHash: snapshot.graph_hash,
          intakeResolutionCount,
        });

        const row: CustomerCensusObservationInsert = {
          id: `ccensus_${nanoid()}`,
          workspace_id: ws,
          run_id,
          population_events: result.population.events,
          population_intents: result.population.intents,
          population_documents: result.population.documents,
          population_total: result.population.total,
          governed_attributed_events: result.governed.attributed_events,
          governed_lineage_edges: result.governed.lineage_edges,
          governed_intake_resolutions: result.governed.intake_resolutions,
          governed_total: result.governed.total,
          orphan_unattributed_events: result.orphans.unattributed_events,
          orphan_dangling_intents: result.orphans.dangling_intents,
          orphan_effect_nodes_without_cause: result.orphans.effect_nodes_without_cause,
          orphan_missing_source_bindings: result.orphans.missing_source_bindings,
          orphan_total: result.orphans.total,
          orphan_set_hash: result.orphan_set_hash,
          graph_hash: result.graph_hash,
        };
        await census.recordObservation(row);

        workspacesObserved += 1;
        totalOrphans += result.orphans.total;
        totalPopulation += result.population.total;
      } catch (_err) {
        // Per-workspace isolation: one failure never aborts the batch.
        workspacesErrored += 1;
      }
    }

    return done(ctx, startedAt, run_id, {
      workspacesObserved,
      workspacesErrored,
      workspacesTruncated,
      totalOrphans,
      totalPopulation,
      workspacesSeen: workspaceIds.length,
      notes:
        `observed ${workspacesObserved}/${workspaceIds.length} workspace(s); ` +
        `${totalOrphans} orphan(s) across ${totalPopulation} population artefact(s); ${workspacesErrored} error(s)` +
        (workspacesTruncated > 0
          ? ` · ⚠ ${workspacesTruncated} workspace(s) hit the ${DATA_GRAPH_FACTS_CAP}-row read cap — their population/orphan counts are UNDER-REPORTED; paginate the facts read before higher-volume tenants`
          : ''),
    });
  } catch (err) {
    // Top-level failure (e.g. the workspace enumeration itself). Never throws — returns a failed result.
    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: workspacesObserved,
      cost_ms: ctx.now().getTime() - startedAt.getTime(),
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      metadata: { loop: LOOP_NAME, workspaces_observed: workspacesObserved, workspaces_errored: workspacesErrored },
    };
  }
};

interface DoneArgs {
  workspacesObserved: number;
  workspacesErrored: number;
  workspacesTruncated: number;
  totalOrphans: number;
  totalPopulation: number;
  workspacesSeen: number;
  notes: string;
}

function done(ctx: CronHandlerContext, startedAt: Date, run_id: string, a: DoneArgs): CronHandlerResult {
  return {
    loop_name: LOOP_NAME,
    run_id,
    actions_taken: a.workspacesObserved,
    cost_ms: ctx.now().getTime() - startedAt.getTime(),
    // A run where a workspace census failed is NOT clean — 'degraded' (which decideCronReport reports)
    // distinguishes it from a fully-observed 'completed'.
    status: a.workspacesErrored > 0 ? 'degraded' : 'completed',
    notes: a.notes,
    metadata: {
      loop: LOOP_NAME,
      workspaces_seen: a.workspacesSeen,
      workspaces_observed: a.workspacesObserved,
      workspaces_errored: a.workspacesErrored,
      workspaces_truncated: a.workspacesTruncated,
      orphan_total: a.totalOrphans,
      population_total: a.totalPopulation,
    },
  };
}
