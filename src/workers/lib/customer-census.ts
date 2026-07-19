// customer-census.ts · J-E TASK 2 (260719) · the PURE tenant-plane sterility census.
//
// This is MB-P's sterility census (git ls-files MINUS graph∪registry∪frontmatter) translated to the
// customer/tenant plane. It answers, per workspace: of everything the tenant PRODUCED (operation_events +
// first-class intents [mig 023] + documents [mig 051]), how much is actually GOVERNED (attributed to a
// project + connected by lineage edges [graph, mig 029] + closed by intake_resolutions [mig 079]), and —
// crucially — WHICH artefacts fall through the cracks (the orphan SET, not merely a cardinality delta).
//
// WHY A SET, NOT A COUNT (the MB-P lesson, reference_mbp_census_set_difference_not_cardinality):
//   A census that subtracts two totals ("population − governed = 42 orphans") NAMES NO ARTEFACT and its
//   counts can silently cancel. So this function builds the actual orphan LISTS (arrays of ids) per class,
//   then reports each class's length AND a stable hash of the full orphan id set. The hash makes the orphan
//   SET drift-detectable across runs (a changed set → a changed hash) WITHOUT persisting any work id/title —
//   the persistence layer stores counts + hashes only (customer-safe, mirroring mig 077's discipline).
//
// PURE: reads + joins the fact/graph arrays, mutates nothing, does no IO. Unit-tested in isolation
// (lib/__tests__/customer-census.test.ts). The impure gateway (crons/customer-census.ts) supplies the
// inputs — assembleDataGraphFacts + buildDataGraph (the SAME customer-safe walkers customer-lineage.ts
// uses) + the intake_resolutions count — and persists the result. This module NEVER remediates: it
// OBSERVES. reclassify_unattributed stays the only remediation arm.

import { CAUSE_EDGE_TYPES, effectNodesRequiringCause } from '../graph/data-graph';
import type { DataGraphFacts, GraphNode, GraphEdge } from '../graph/data-graph';

/** The catch-all bucket the pre-split backlog was dumped into — an event pointing at `%-allactivity` is
 *  NOT genuinely attributed (matches reclassify-store's unattributed SELECT: project_id IS NULL OR LIKE
 *  '%-allactivity'). Kept in sync with dal/reclassify-store.ts by intent. */
const ALLACTIVITY_SUFFIX = '-allactivity';

export interface CensusInputs {
  readonly workspaceId: string;
  /** From dal.assembleDataGraphFacts(ws, { includeDocuments }). */
  readonly facts: DataGraphFacts;
  /** From buildDataGraph(ws, facts). */
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** buildDataGraph(...).snapshot.graph_hash — carried through for drift correlation. */
  readonly graphHash: string;
  /** Count of governed intake_resolutions (mig 079) for this workspace. Impure read, injected. */
  readonly intakeResolutionCount: number;
}

export interface CensusPopulation {
  readonly events: number;
  readonly intents: number;
  readonly documents: number;
  readonly total: number;
}

export interface CensusGoverned {
  readonly attributed_events: number;
  readonly lineage_edges: number;
  readonly intake_resolutions: number;
  readonly total: number;
}

export interface CensusOrphans {
  readonly unattributed_events: number;
  readonly dangling_intents: number;
  readonly effect_nodes_without_cause: number;
  readonly missing_source_bindings: number;
  readonly total: number;
}

export interface CensusResult {
  readonly workspace_id: string;
  readonly population: CensusPopulation;
  readonly governed: CensusGoverned;
  readonly orphans: CensusOrphans;
  /** Stable hash of the sorted, class-prefixed orphan id SET (drift detection; no ids persisted). */
  readonly orphan_set_hash: string;
  readonly graph_hash: string;
}

/** An event row (event_sourcing plane) is "unattributed" iff its project_id is null/empty OR points at the
 *  pre-split '%-allactivity' catch-all. Mirrors dal/reclassify-store.ts listUnattributedEventsRow. */
function isUnattributedProjectId(projectId: string | null | undefined): boolean {
  const pid = (projectId == null ? '' : String(projectId)).trim();
  return pid === '' || pid.endsWith(ALLACTIVITY_SUFFIX);
}

/** djb2 over a class-prefixed, sorted id list → `orh_<hex>`. Same hash family as computeGraphHash so the
 *  format is consistent across the graph substrate. A different orphan SET yields a different hash. */
function hashOrphanSet(classedIds: string[]): string {
  const material = [...classedIds].sort().join('\n');
  let h = 5381;
  for (let i = 0; i < material.length; i++) h = ((h << 5) + h + material.charCodeAt(i)) >>> 0;
  return `orh_${h.toString(16)}`;
}

/**
 * Compute the sterility census for ONE workspace. Pure. Builds the orphan id LISTS per class (the honest
 * set-difference), then reports counts + a set hash. See module header for the doctrine.
 */
export function computeWorkspaceCensus(inputs: CensusInputs): CensusResult {
  const ws = String(inputs.workspaceId);
  const facts = inputs.facts;
  const nodes = inputs.nodes;
  const edges = inputs.edges;

  // ── POPULATION ──────────────────────────────────────────────────────────────
  // Event-plane rows (operation_events) come through the facts UNION as plane='event_sourcing'.
  const eventRows = facts.unified.filter((u) => u.plane === 'event_sourcing' && (u.workspace_id ?? ws) === ws);
  const intentRows = facts.intents.filter((i) => (i.workspace_id ?? ws) === ws);
  const documentRows = (facts.documents ?? []).filter((d) => (d.workspace_id ?? ws) === ws);

  const populationEvents = eventRows.length;
  const populationIntents = intentRows.length;
  const populationDocuments = documentRows.length;

  // ── ORPHAN CLASS 1 · unattributed events (set, not a subtraction) ────────────
  const unattributedEventIds = eventRows
    .filter((u) => isUnattributedProjectId(u.project_id))
    .map((u) => String(u.source_plane_id || u.id));

  // Governed events = the complement (events carrying a real project_id).
  const attributedEvents = populationEvents - unattributedEventIds.length;

  // ── ORPHAN CLASS 2 · dangling intents ────────────────────────────────────────
  // A dangling intent = an intent node touched by ZERO edges: no project `scopes` it, it derives from
  // nothing, and no event `realizes` it. That is a first-class artefact with no place in the lineage.
  const edgeEndpoints = new Set<string>();
  for (const e of edges) { edgeEndpoints.add(e.from); edgeEndpoints.add(e.to); }
  const danglingIntentIds = nodes
    .filter((n) => n.type === 'intent' && !edgeEndpoints.has(n.id))
    .map((n) => n.id);

  // ── ORPHAN CLASS 3 · effect nodes without a resolvable cause (data-graph.ts:331-335) ──
  // effectNodesRequiringCause = packets (+ events already on a causal chain). An orphan here is such a node
  // with NO OUTGOING cause-edge {caused_by, realizes, derived_from} — i.e. an effect whose cause is missing.
  const hasOutgoingCause = new Set<string>();
  for (const e of edges) if (CAUSE_EDGE_TYPES.has(e.type)) hasOutgoingCause.add(e.from);
  const effectNodesWithoutCauseIds = effectNodesRequiringCause(nodes as GraphNode[], edges as GraphEdge[])
    .filter((n) => !hasOutgoingCause.has(n.id))
    .map((n) => n.id);

  // ── ORPHAN CLASS 4 · missing source bindings ─────────────────────────────────
  // The lineage origin is the connected `source` (ADR-ARCH-003 VI.2): source —feeds→ project. A project
  // with NO incoming `feeds` edge has no governed lineage origin — its activity cannot be traced to a source.
  const feedsTargets = new Set<string>();
  for (const e of edges) if (e.type === 'feeds') feedsTargets.add(e.to);
  const missingSourceBindingIds = nodes
    .filter((n) => n.type === 'project' && !feedsTargets.has(n.id))
    .map((n) => n.id);

  // ── AGGREGATE ─────────────────────────────────────────────────────────────────
  const orphanTotal =
    unattributedEventIds.length +
    danglingIntentIds.length +
    effectNodesWithoutCauseIds.length +
    missingSourceBindingIds.length;

  const lineageEdges = edges.length;
  const governedTotal = attributedEvents + lineageEdges + inputs.intakeResolutionCount;
  const populationTotal = populationEvents + populationIntents + populationDocuments;

  // Class-prefix each orphan id before hashing so identical ids in different classes don't collide.
  const classedOrphanIds = [
    ...unattributedEventIds.map((id) => `ue:${id}`),
    ...danglingIntentIds.map((id) => `di:${id}`),
    ...effectNodesWithoutCauseIds.map((id) => `ec:${id}`),
    ...missingSourceBindingIds.map((id) => `ms:${id}`),
  ];

  return {
    workspace_id: ws,
    population: { events: populationEvents, intents: populationIntents, documents: populationDocuments, total: populationTotal },
    governed: { attributed_events: attributedEvents, lineage_edges: lineageEdges, intake_resolutions: inputs.intakeResolutionCount, total: governedTotal },
    orphans: {
      unattributed_events: unattributedEventIds.length,
      dangling_intents: danglingIntentIds.length,
      effect_nodes_without_cause: effectNodesWithoutCauseIds.length,
      missing_source_bindings: missingSourceBindingIds.length,
      total: orphanTotal,
    },
    orphan_set_hash: hashOrphanSet(classedOrphanIds),
    graph_hash: inputs.graphHash,
  };
}
