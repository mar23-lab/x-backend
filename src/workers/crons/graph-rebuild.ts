// crons/graph-rebuild.ts · ADR-XLOOP-ARCH-004 Phase A · the data-graph's POPULATION mechanism.
//
// The persisted data-graph (029) had a home but no FEEDER: graph_* stayed empty because a rebuild only
// ran via the operator-only POST /graph/rebuild (Clerk-gated). This cron rebuilds the graph for every
// operator workspace on its schedule — worker env (DATABASE_URL binding), NOT user auth — so the graph
// self-populates + stays fresh without a manual operator trigger. Idempotent: persistDataGraph writes
// ONLY when the graph_hash changed (drift), so a no-change fire is a cheap "fresh" no-op.
//
// Chained into the hourly slot (see crons/index.ts). Best-effort per workspace: one bad workspace never
// aborts the run. Operator-scoped only (listWorkspacesForOperator) — never touches a customer tenant.

import type { CronHandler } from './types';
import { envFlagTrue } from '../lib/env-flag';
import { persistDataGraph, type GraphPersistDeps } from '../graph/persist-data-graph';

const LOOP_NAME = 'graph_rebuild';

export const graphRebuildCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const run_id = `graph_rebuild_${startedAt.toISOString()}`;
  const cost = () => ctx.now().getTime() - startedAt.getTime();

  const ownerUserId = String(ctx.env?.MBP_OWNER_USER_ID || '').trim();
  const linked = String(ctx.env?.MBP_OWNER_LINKED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ids = [ownerUserId, ...linked].filter(Boolean);
  if (ids.length === 0) {
    return { loop_name: LOOP_NAME, run_id, actions_taken: 0, cost_ms: cost(), status: 'skipped', notes: 'no operator identity (MBP_OWNER_USER_ID unset)', metadata: { reason: 'no_operator' } };
  }

  // ARCH-006 W2.1 (D2) — before re-projecting, ensure github_repo source bindings exist for every repo
  // the operator's github events reference. This makes the data-graph's `source` node + `feeds` edge
  // REAL (census showed source=0 because the github webhook writes events but no binding). Idempotent +
  // operator-scoped + best-effort: a failure here never aborts the rebuild.
  let bindings_ensured = 0;
  try {
    const ensure = (ctx.dal as { ensureGithubRepoBindingsForOperator?: (i: string[]) => Promise<number> }).ensureGithubRepoBindingsForOperator;
    if (typeof ensure === 'function') bindings_ensured = await ensure.call(ctx.dal, ids);
  } catch { /* best-effort — lineage backfill must never break the rebuild */ }

  let rebuilt = 0, fresh = 0, errors = 0, nodes = 0, edges = 0, scanned = 0;
  // ARCH-006 audit fix: a per-workspace failure used to be counted (errors++) but its MESSAGE was
  // discarded, so a chronic single-workspace failure stayed invisible while the run reported 'completed'.
  // Capture WHICH workspace failed and WHY (capped), surface it in metadata+notes (index.ts forwards both),
  // and escalate status to 'degraded' on any partial failure so it shows in wrangler tail.
  const errorDetails: Array<{ ws: string; msg: string }> = [];
  try {
    const workspaces = await ctx.dal.listWorkspacesForOperator(ids);
    for (const ws of workspaces) {
      const wsId = String((ws as { id?: string }).id || '').trim();
      if (!wsId) continue;
      scanned += 1;
      try {
        const includeDocuments = envFlagTrue((ctx.env as { GRAPH_DOCUMENT_NODES_ENABLED?: string })?.GRAPH_DOCUMENT_NODES_ENABLED);
        const r = await persistDataGraph(ctx.dal as unknown as GraphPersistDeps, wsId, ctx.now().toISOString(), { includeDocuments });
        if (r.persisted) rebuilt += 1; else fresh += 1;
        nodes += r.node_count; edges += r.edge_count;
      } catch (e) {
        errors += 1;
        if (errorDetails.length < 10) errorDetails.push({ ws: wsId, msg: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    return { loop_name: LOOP_NAME, run_id, actions_taken: rebuilt, cost_ms: cost(), status: 'failed', error: e instanceof Error ? e.message : String(e), metadata: { scanned, rebuilt, fresh, errors, error_details: errorDetails } };
  }

  // total failure (nothing rebuilt/fresh) = 'failed'; partial failure (some succeeded, some errored) =
  // 'degraded' (no longer a clean 'completed'); all clean = 'completed'.
  const degraded = errors > 0;
  const status = errors > 0 && rebuilt === 0 && fresh === 0 ? 'failed' : degraded ? 'degraded' : 'completed';
  return {
    loop_name: LOOP_NAME, run_id, actions_taken: rebuilt, cost_ms: cost(),
    status,
    notes: `${degraded ? 'DEGRADED ' : ''}scanned=${scanned} rebuilt=${rebuilt} fresh=${fresh} errors=${errors} · nodes=${nodes} edges=${edges} · gh_bindings=${bindings_ensured}${errorDetails.length ? ' · failed_ws=' + errorDetails.map((d) => d.ws).join(',') : ''}`,
    metadata: { scanned, rebuilt, fresh, errors, nodes, edges, bindings_ensured, degraded, error_details: errorDetails },
  };
};
