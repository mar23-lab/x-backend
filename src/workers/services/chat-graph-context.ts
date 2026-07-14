// chat-graph-context.ts · W5 customer-governance wave (260708) · G6 — graph-aware chat context, PURE.
//
// Until now the chief-of-staff consulted the graph ONLY for pinned cards (OS-4 P4); the scoped record it
// answers over had no lineage and no causation. This module is the PURE selection layer that fixes it
// without growing cockpit-chat.ts (995 LOC, WARN band — the mandated sub-facade decomposition): the ROUTE
// fetches lineage neighborhoods for the top scoped events (the same getArtefactLineage read the pinned path
// uses, flag CHAT_GRAPH_CONTEXT_ENABLED) and THIS module selects which edges enter the model's budget —
// CAUSE-edges first (caused_by/realizes/derived_from — the "why" chains, validated via traceCause so a
// surfaced chain actually terminates), then containment/context edges — deduped, deterministic, ≤ budget.
// The selected edges ride the EXISTING facts.lineage channel; cockpit-chat renders them unchanged.

import { traceCause, CAUSE_EDGE_TYPES, type GraphEdge, type GraphEdgeType } from '../graph/data-graph';
import type { LineageEdgeRow } from '../dal/graph-store';

export const CHAT_GRAPH_EDGE_BUDGET = 30; // the OS-4 P4 prompt budget — never exceeded

/** LineageEdgeRow → the pure GraphEdge shape traceCause consumes. */
function toGraphEdge(l: LineageEdgeRow): GraphEdge {
  return { from: l.edge_from, to: l.edge_to, type: l.edge_type as GraphEdgeType };
}

const edgeKey = (l: LineageEdgeRow): string => `${l.edge_from}>${l.edge_type}>${l.edge_to}`;

/**
 * Select the graph context for a chat turn: dedupe candidate edges (pinned lineage first — the operator's
 * explicit signal always survives), then prioritize TERMINATING cause-chains from the anchors (an RCA chain
 * that reaches a root is worth more than scattered containment edges), then fill with the rest. Pure +
 * deterministic (stable input order → stable output); never exceeds the budget.
 */
export function selectGraphContext(
  pinnedLineage: LineageEdgeRow[],
  scopedLineage: LineageEdgeRow[],
  anchors: string[],
  budget: number = CHAT_GRAPH_EDGE_BUDGET,
): { edges: LineageEdgeRow[]; cause_chains: Array<{ start: string; roots: string[]; terminated: boolean }> } {
  const seen = new Set<string>();
  const dedup = (rows: LineageEdgeRow[]): LineageEdgeRow[] => {
    const out: LineageEdgeRow[] = [];
    for (const r of rows || []) { const k = edgeKey(r); if (!seen.has(k)) { seen.add(k); out.push(r); } }
    return out;
  };

  const pinned = dedup(pinnedLineage);
  const scoped = dedup(scopedLineage);
  const all = [...pinned, ...scoped];
  const graphEdges = all.map(toGraphEdge);

  // Trace the cause-chains from each anchor over the FULL candidate set; keep the chains that terminate
  // (HR-CAUSATION-TRACEABILITY-1: a cyclic/unterminated chain is a defect, not context).
  const cause_chains: Array<{ start: string; roots: string[]; terminated: boolean }> = [];
  const causeEdgeKeys = new Set<string>();
  for (const a of anchors || []) {
    if (!a) continue;
    const trace = traceCause(graphEdges, a, 'backward');
    if (!trace.terminated || trace.visited.length <= 1) continue;
    cause_chains.push({ start: a, roots: trace.roots, terminated: true });
    const onChain = new Set(trace.visited);
    for (const l of all) {
      if (CAUSE_EDGE_TYPES.has(l.edge_type as GraphEdgeType) && onChain.has(l.edge_from) && onChain.has(l.edge_to)) {
        causeEdgeKeys.add(edgeKey(l));
      }
    }
  }

  // Budgeted selection: pinned first (always), then chain cause-edges, then the remainder in input order.
  const out: LineageEdgeRow[] = [];
  const taken = new Set<string>();
  const take = (rows: LineageEdgeRow[], pred: (l: LineageEdgeRow) => boolean) => {
    for (const r of rows) {
      if (out.length >= budget) return;
      const k = edgeKey(r);
      if (!taken.has(k) && pred(r)) { taken.add(k); out.push(r); }
    }
  };
  take(pinned, () => true);
  take(scoped, (l) => causeEdgeKeys.has(edgeKey(l)));
  take(scoped, () => true);
  return { edges: out, cause_chains };
}
