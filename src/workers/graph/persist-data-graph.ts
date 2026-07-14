// persist-data-graph.ts · ADR-XLOOP-ARCH-003 Phase 2 · buildDataGraph's first real PRODUCTION caller.
//
// The pure projection (data-graph.ts) + the I/O DAL (graph-store.ts) meet here. This module:
//   * persistDataGraph  — assemble facts → buildDataGraph → compare hash to the stored snapshot (drift
//                          detection) → drop-and-rebuild the materialized graph + append the snapshot.
//                          Only writes when the graph actually CHANGED (drift !== 'fresh') — idempotent.
//   * checkGraphDrift   — re-project + compare WITHOUT writing (the HR-UNIFIED-GRAPH-DERIVED-1 read-side
//                          drift gate: a stored hash that != the fresh re-projection = drift).
//   * tenantSafeGraphDigest — a pure IP-light aggregate (counts + recent labels + root-cause chains) for
//                          the MB-P export; carries NO derivation IP, NO operator cross-workspace lens
//                          (buildDataGraph already excludes workspace_id=null lenses from a tenant graph).
//
// Depends on a NARROW interface (GraphPersistDeps) so it is unit-testable against an in-memory fake.

import { buildDataGraph, traceCause, effectNodesRequiringCause, type GraphNode, type GraphEdge, type DataGraphFacts } from './data-graph';
import type { GraphSnapshotRow } from '../dal/graph-store';

export interface GraphPersistDeps {
  assembleDataGraphFacts(workspaceId: string, opts?: { includeDocuments?: boolean }): Promise<DataGraphFacts>;
  getLatestGraphSnapshot(workspaceId: string): Promise<GraphSnapshotRow | null>;
  replaceWorkspaceGraph(workspaceId: string, nodes: GraphNode[], edges: GraphEdge[], meta: { graph_hash: string; graph_version: number; node_count: number; edge_count: number }, generatedAtIso: string): Promise<void>;
}

export type GraphDrift = 'new' | 'fresh' | 'changed';

export interface PersistResult {
  workspace_id: string; generated_at: string; drift: GraphDrift;
  graph_hash: string; node_count: number; edge_count: number; persisted: boolean;
}

function driftOf(prev: GraphSnapshotRow | null, freshHash: string): GraphDrift {
  if (!prev) return 'new';
  return prev.graph_hash === freshHash ? 'fresh' : 'changed';
}

/** Rebuild + persist the materialized graph for one workspace. Writes only when it changed. */
export async function persistDataGraph(deps: GraphPersistDeps, workspaceId: string, nowIso: string, opts?: { includeDocuments?: boolean }): Promise<PersistResult> {
  const facts = await deps.assembleDataGraphFacts(workspaceId, opts);
  const { nodes, edges, snapshot } = buildDataGraph(workspaceId, facts);
  const prev = await deps.getLatestGraphSnapshot(workspaceId);
  const drift = driftOf(prev, snapshot.graph_hash);
  const persisted = drift !== 'fresh';
  if (persisted) {
    await deps.replaceWorkspaceGraph(workspaceId, nodes, edges,
      { graph_hash: snapshot.graph_hash, graph_version: snapshot.graph_version, node_count: snapshot.node_count, edge_count: snapshot.edge_count }, nowIso);
  }
  return { workspace_id: workspaceId, generated_at: nowIso, drift, graph_hash: snapshot.graph_hash, node_count: snapshot.node_count, edge_count: snapshot.edge_count, persisted };
}

/** Read-side drift gate: is the stored snapshot still equal to a fresh re-projection of the facts? */
export async function checkGraphDrift(deps: GraphPersistDeps, workspaceId: string, opts?: { includeDocuments?: boolean }): Promise<{ drift: GraphDrift; stored_hash: string | null; fresh_hash: string; node_count: number; edge_count: number }> {
  const facts = await deps.assembleDataGraphFacts(workspaceId, opts);
  const { snapshot } = buildDataGraph(workspaceId, facts);
  const prev = await deps.getLatestGraphSnapshot(workspaceId);
  return { drift: driftOf(prev, snapshot.graph_hash), stored_hash: prev?.graph_hash ?? null, fresh_hash: snapshot.graph_hash, node_count: snapshot.node_count, edge_count: snapshot.edge_count };
}

// ── tenant-safe export digest (pure) ──────────────────────────────────────────
export interface GraphDigest {
  schema_id: 'xlooop.product_graph_digest.v1';
  workspace_id: string;
  generated_at: string;
  graph_hash: string;
  node_counts: Record<string, number>;
  edge_counts: Record<string, number>;
  recent: Array<{ type: string; description: string; occurred_at: string | null }>;
  // RCA roots: for each effect node requiring a cause, where its backward walk terminates (root-cause).
  root_causes: Array<{ effect: string; roots: string[]; terminated: boolean }>;
}

/** A pure, IP-light aggregate over a built graph — for the MB-P export. NO derivation fingerprints,
 *  NO binding internals, NO per-tenant raw rows beyond the owner's own labels; the operator cross-
 *  workspace lens is already excluded upstream (buildDataGraph). recentLimit caps the surface. */
export function tenantSafeGraphDigest(
  workspaceId: string, nodes: GraphNode[], edges: GraphEdge[], graphHash: string, generatedAt: string, recentLimit = 20,
): GraphDigest {
  const node_counts: Record<string, number> = {};
  for (const n of nodes) node_counts[n.type] = (node_counts[n.type] || 0) + 1;
  const edge_counts: Record<string, number> = {};
  for (const e of edges) edge_counts[e.type] = (edge_counts[e.type] || 0) + 1;

  const recent = [...nodes]
    .filter((n) => n.occurred_at)
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
    .slice(0, recentLimit)
    .map((n) => ({ type: n.type, description: String(n.description || n.label || n.ref_id).slice(0, 200), occurred_at: n.occurred_at ?? null }));

  const root_causes = effectNodesRequiringCause(nodes, edges).slice(0, recentLimit).map((n) => {
    const t = traceCause(edges, n.id, 'backward');
    return { effect: n.id, roots: t.roots, terminated: t.terminated };
  });

  return {
    schema_id: 'xlooop.product_graph_digest.v1',
    workspace_id: workspaceId, generated_at: generatedAt, graph_hash: graphHash,
    node_counts, edge_counts, recent, root_causes,
  };
}
