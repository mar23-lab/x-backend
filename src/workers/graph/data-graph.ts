// data-graph.ts · ADR-XLOOP-IA-001 R3 · the Unified Temporal Data Graph as a DERIVED PROJECTION.
//
// The information model (workspace → project → event/packet/intent, lens → project, intent lineage) is
// already encoded relationally. This module renders it as ONE temporally-stamped graph WITHOUT a new
// source of truth: `buildDataGraph` is a PURE function over fact arrays (it reads + joins, mutates
// nothing, never writes a DB) and `computeGraphHash` makes the snapshot drift-detectable. The graph can
// never drift from the facts because it is derived — rebuild = re-project (HR-UNIFIED-GRAPH-DERIVED-1).
//
// Every node is workspace-scoped (tenant isolation) and carries its source row's bitemporal stamps
// (occurred_at = valid-time, ingested_at = transaction-time). Lenses point AT the structure (lens→project
// 'views' edge); the structure never points back at a lens (the L2-projection-over-L0-facts invariant).

// 7 node types. `source` (a project_source_binding) is the LINEAGE ORIGIN — the chain now starts at
// the connected source, not at the project (ADR-XLOOP-ARCH-003 VI.2). source —feeds→ project.
export type GraphNodeType = 'workspace' | 'project' | 'lens' | 'intent' | 'packet' | 'event' | 'source' | 'document';
// EMITTED edges: contains, views, scopes, derived_from, realizes, feeds, caused_by.
//   feeds      — source → project (lineage origin; ADR-ARCH-003 VI.2).
//   caused_by  — effect → cause (PROV wasInformedBy / wasDerivedFrom direction; ADR-ARCH-003 VII).
//                Emitted from the caller-supplied `causation` pairs (derived from audit_logs.causation_id);
//                a packet/decision points BACKWARD to the event/decision that caused it. The RCA walk
//                follows {caused_by, realizes, derived_from} to a root (HR-CAUSATION-TRACEABILITY-1).
//   governs    — DEPRECATED alias of the cause→effect direction; kept in the union for back-compat but
//                NO LONGER emitted (superseded by the PROV-aligned `caused_by`). (`in_plane` was never a
//                code edge — it lived only in an earlier doc draft.)
export type GraphEdgeType = 'contains' | 'views' | 'scopes' | 'derived_from' | 'realizes' | 'feeds' | 'caused_by' | 'governs' | 'evidences';
export type GraphPlane = 'event_sourcing' | 'governance' | 'synthetic';
// The cause-direction edges an RCA backward walk follows from an effect node to a root cause.
export const CAUSE_EDGE_TYPES: ReadonlySet<GraphEdgeType> = new Set<GraphEdgeType>(['caused_by', 'realizes', 'derived_from']);

export interface GraphNode {
  id: string;                     // e.g. "project:proj_123"
  type: GraphNodeType;
  workspace_id: string;           // tenant scope — ALWAYS present
  ref_id: string;                 // the source row id
  label?: string | null;
  description?: string | null;    // DERIVED at projection time (title/summary/source_ref) — NEVER stored on L0.
                                  // Non-empty for every node (falls back to label/ref_id); HR-PRODUCT-GRAPH-PROJECTION-1.
  plane?: GraphPlane | null;      // for event/packet nodes (the 3-plane label)
  occurred_at?: string | null;    // valid-time
  ingested_at?: string | null;    // transaction-time
  domain_ref?: ResolvedDomain | null; // typed resolution of a soft domain_id tag (the integrity fix)
}

export interface GraphEdge {
  from: string;                   // node id
  to: string;                     // node id
  type: GraphEdgeType;
}

export interface GraphSnapshot {
  schema_id: 'xlooop.data_graph_snapshot.v1';
  workspace_id: string;
  generated_at: string;           // stamped by the caller (kept out of the pure builder for determinism)
  graph_version: number;
  graph_hash: string;             // deterministic hash of the sorted node+edge ids → drift detection
  node_count: number;
  edge_count: number;
}

// ── the typed domain_id resolver — closes the 1 integrity gap ─────────────────
// `domain_id` is loosely typed across the schema: it resolves to EITHER a synthetic_domain (lens) id OR
// an external MB-P life-domain id, with no FK. This makes that ambiguity explicit + unambiguous.
export type ResolvedDomain = { kind: 'lens' | 'life' | 'unknown'; id: string };

export interface DomainResolutionContext {
  lensIds: ReadonlySet<string> | string[];     // synthetic_domains.id present in this workspace
  lifeDomainIds?: ReadonlySet<string> | string[]; // external MB-P life-domain node ids (off-DB)
}

export function resolveDomainId(domainId: string | null | undefined, ctx: DomainResolutionContext): ResolvedDomain | null {
  const id = (domainId == null ? '' : String(domainId)).trim();
  if (!id) return null;
  const lens = ctx.lensIds instanceof Set ? ctx.lensIds : new Set(ctx.lensIds || []);
  const life = ctx.lifeDomainIds instanceof Set ? ctx.lifeDomainIds : new Set(ctx.lifeDomainIds || []);
  if (lens.has(id)) return { kind: 'lens', id };
  if (life.has(id)) return { kind: 'life', id };
  // Heuristic fallback when the membership sets are incomplete. ONLY a NAMESPACE-PREFIXED
  // MB-P life-domain id resolves to 'life' (domain:mbp:* / life:* / domain:<ns>:{career|health|
  // companies|trust}). A bare id (e.g. 'companies-pipeline', 'trust-ledger', 'healthkit-lens')
  // is NOT guessed — it returns 'unknown' rather than risk misclassifying a LENS as a life-domain.
  if (/^(domain:mbp[:.]|life:|domain:[^:]*:(career|health|companies|trust)\b)/i.test(id)) return { kind: 'life', id };
  return { kind: 'unknown', id };
}

// ── the fact inputs (shapes mirror the relational rows; only the joined fields) ──
export interface DataGraphFacts {
  workspaces: Array<{ id: string; name?: string | null }>;
  projects: Array<{ id: string; workspace_id: string; status?: string | null; parent_project_id?: string | null; name?: string | null; description?: string | null; created_at?: string | null }>;
  lenses: Array<{ id: string; workspace_id: string | null; slug?: string | null; label?: string | null; created_at?: string | null }>;
  memberships: Array<{ domain_id: string; project_id: string }>;
  intents: Array<{ id: string; workspace_id?: string | null; project_id?: string | null; domain_id?: string | null; derived_from?: string | null; title?: string | null; created_at?: string | null }>;
  // operations_unified rows (plane-labelled event/packet facts). `intent_id` comes from the facts-join
  // (operation_events ⨝ operations_unified) the persist handler performs — operations_unified itself
  // lacks intent_id (ADR-ARCH-003 VI.2 step 3).
  unified: Array<{ id: string; plane: GraphPlane; source_plane_id?: string | null; workspace_id?: string | null; project_id?: string | null; domain_id?: string | null; kind?: string | null; occurred_at?: string | null; ingested_at?: string | null; summary?: string | null; title?: string | null; intent_id?: string | null }>;
  // project_source_bindings → the `source` lineage-origin node + the `feeds` edge (optional; ADR-ARCH-003 VI.2).
  bindings?: Array<{ id: string; workspace_id?: string | null; project_id?: string | null; source_kind?: string | null; source_ref?: unknown; created_at?: string | null }>;
  // W3 (260708) · documents as first-class lineage nodes (051 version chain). OPTIONAL + flag-gated at the
  // facts-assembly layer (GRAPH_DOCUMENT_NODES_ENABLED) so the graph_hash stays byte-stable flag-off.
  documents?: Array<{ id: string; workspace_id?: string | null; project_id?: string | null; title?: string | null; content_hash?: string | null; supersedes_id?: string | null; created_at?: string | null }>;
  // W3 · evidence_items rows for the document —evidences→ packet/event join (051 doctrine link:
  // evidence_items.content_hash = documents.content_hash).
  evidenceLinks?: Array<{ content_hash?: string | null; packet_id?: string | null; event_id?: string | null }>;
  // causation pairs (effect node-id → cause node-id), derived by the caller from audit_logs.causation_id.
  // Both ids are FULL node ids (e.g. {effect:'packet:pkt-1', cause:'event:evt-1'}); the builder only emits
  // the edge when BOTH nodes exist in this workspace graph (tenant-scoped). ADR-ARCH-003 VII.
  causation?: Array<{ effect: string; cause: string }>;
}

const PACKET_KINDS = new Set(['packet', 'decision', 'governance_event', 'sign_off']);

/** Derive a human label for a `source` node from its binding's source_ref (label/path/repo) — pure,
 *  no L0 read. Falls back to source_kind, then the binding id, so a source node is NEVER label-less. */
function sourceLabel(b: { id: string; source_kind?: string | null; source_ref?: unknown }): string {
  const ref = b.source_ref;
  if (ref && typeof ref === 'object') {
    const r = ref as Record<string, unknown>;
    const pick = r.label ?? r.name ?? r.repo ?? r.path ?? r.url;
    if (pick != null && String(pick).trim()) return String(pick).slice(0, 200);
  } else if (typeof ref === 'string' && ref.trim()) {
    return ref.slice(0, 200);
  }
  return String(b.source_kind || b.id);
}
/** A node's derived description is never empty — the lineage-completeness invariant (HR-PRODUCT-GRAPH-PROJECTION-1). */
const nonEmpty = (...vals: Array<string | null | undefined>): string => {
  for (const v of vals) { if (v != null && String(v).trim()) return String(v).slice(0, 280); }
  return '';
};

/**
 * Build the unified data graph for a SINGLE workspace from the relational facts. Pure: reads + joins,
 * mutates nothing, writes nothing. Returns nodes + edges + a snapshot (the caller stamps generated_at).
 */
export function buildDataGraph(workspaceId: string, facts: DataGraphFacts): { nodes: GraphNode[]; edges: GraphEdge[]; snapshot: Omit<GraphSnapshot, 'generated_at'> } {
  const ws = String(workspaceId);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenNode = new Set<string>();
  const seenEdge = new Set<string>();
  const addNode = (n: GraphNode) => { if (!seenNode.has(n.id)) { seenNode.add(n.id); nodes.push(n); } };
  // dedupe (from,to,type) so edge_count == the persisted distinct-edge PK and the hash is dup-stable.
  const addEdge = (from: string, to: string, type: GraphEdgeType) => { const k = `${from}>${type}>${to}`; if (!seenEdge.has(k)) { seenEdge.add(k); edges.push({ from, to, type }); } };

  // lens-id set for the typed resolver (this workspace + cross-workspace operator lenses)
  const lensIds = new Set(facts.lenses.filter((l) => l.workspace_id === ws || l.workspace_id == null).map((l) => l.id));
  const domCtx: DomainResolutionContext = { lensIds };

  // L0/L1 — workspace + projects (the spine)
  const wsRow = facts.workspaces.find((w) => w.id === ws);
  addNode({ id: `workspace:${ws}`, type: 'workspace', workspace_id: ws, ref_id: ws, label: wsRow?.name ?? null, description: nonEmpty(wsRow?.name, ws) });
  const wsProjects = facts.projects.filter((p) => p.workspace_id === ws);
  const projectIds = new Set(wsProjects.map((p) => p.id));
  for (const p of wsProjects) {
    addNode({ id: `project:${p.id}`, type: 'project', workspace_id: ws, ref_id: p.id, occurred_at: p.created_at ?? null, label: nonEmpty(p.name, p.id), description: nonEmpty(p.description, p.name, p.id) });
    addEdge(`workspace:${ws}`, `project:${p.id}`, 'contains');
  }

  // SOURCE nodes (lineage origin) + the `feeds` edge (source → project). The chain now starts at the
  // connected source, not the project (ADR-ARCH-003 VI.2). One-directional: source points AT the project;
  // the projection never mutates the binding (same discipline as lens→project).
  for (const b of facts.bindings ?? []) {
    if ((b.workspace_id ?? ws) !== ws) continue;
    const sid = `source:${b.id}`;
    const lbl = sourceLabel(b);
    addNode({ id: sid, type: 'source', workspace_id: ws, ref_id: b.id, label: lbl, description: nonEmpty(lbl, b.source_kind, b.id), occurred_at: b.created_at ?? null });
    if (b.project_id && projectIds.has(b.project_id)) addEdge(sid, `project:${b.project_id}`, 'feeds');
  }

  // L2 — lenses + the views edge (lens → project, NEVER the reverse).
  // EXACT workspace match only: a cross-workspace operator lens (workspace_id == null,
  // visibility=operator_only) is OPERATOR-ONLY and must NOT appear in a tenant's graph
  // stamped to that tenant (the prior `|| workspace_id == null` clause leaked a global lens
  // into every tenant with provenance masked). Operator-scoped graphs are a separate concern.
  const wsLenses = facts.lenses.filter((l) => l.workspace_id === ws);
  for (const l of wsLenses) addNode({ id: `lens:${l.id}`, type: 'lens', workspace_id: ws, ref_id: l.id, label: l.label ?? l.slug ?? l.id, description: nonEmpty(l.label, l.slug, l.id), occurred_at: l.created_at ?? null });
  for (const m of facts.memberships) {
    if (lensIds.has(m.domain_id) && projectIds.has(m.project_id)) addEdge(`lens:${m.domain_id}`, `project:${m.project_id}`, 'views');
  }

  // L0 — intents (lineage) scoped to the workspace
  const intentIds = new Set(facts.intents.filter((i) => (i.workspace_id ?? ws) === ws).map((i) => i.id));
  for (const i of facts.intents) {
    if ((i.workspace_id ?? ws) !== ws) continue;
    addNode({ id: `intent:${i.id}`, type: 'intent', workspace_id: ws, ref_id: i.id, label: nonEmpty(i.title, i.id), description: nonEmpty(i.title, i.id), occurred_at: i.created_at ?? null, domain_ref: resolveDomainId(i.domain_id, domCtx) });
    if (i.project_id && projectIds.has(i.project_id)) addEdge(`project:${i.project_id}`, `intent:${i.id}`, 'scopes');
    if (i.derived_from && intentIds.has(i.derived_from)) addEdge(`intent:${i.id}`, `intent:${i.derived_from}`, 'derived_from');
  }

  // L0 — events + packets from operations_unified (the 3-plane substrate)
  for (const u of facts.unified) {
    if ((u.workspace_id ?? ws) !== ws) continue;
    const isPacket = u.plane === 'governance' || PACKET_KINDS.has(String(u.kind || ''));
    const type: GraphNodeType = isPacket ? 'packet' : 'event';
    const nid = `${type}:${u.source_plane_id || u.id}`;
    addNode({ id: nid, type, workspace_id: ws, ref_id: u.source_plane_id || u.id, plane: u.plane, occurred_at: u.occurred_at ?? null, ingested_at: u.ingested_at ?? null, label: u.summary ?? null, description: nonEmpty(u.summary, u.title, u.source_plane_id, u.id), domain_ref: resolveDomainId(u.domain_id, domCtx) });
    if (u.project_id && projectIds.has(u.project_id)) addEdge(`project:${u.project_id}`, nid, 'scopes');
    if (u.intent_id && intentIds.has(u.intent_id)) addEdge(nid, `intent:${u.intent_id}`, 'realizes');
  }

  // W3 · DOCUMENT nodes (051 version chain) + edges. project —contains→ document (workspace —contains→ when
  // unscoped) · document —derived_from→ its superseded version (version chains ARE derivation) ·
  // document —evidences→ packet/event via the 051 content_hash join. Same both-endpoints-exist discipline
  // as causation (no fabricated/dangling edges).
  const docIds = new Set((facts.documents ?? []).filter((d) => (d.workspace_id ?? ws) === ws).map((d) => d.id));
  const docsByHash = new Map<string, string[]>();
  for (const d of facts.documents ?? []) {
    if ((d.workspace_id ?? ws) !== ws) continue;
    const did = `document:${d.id}`;
    addNode({ id: did, type: 'document', workspace_id: ws, ref_id: d.id, label: nonEmpty(d.title, d.id), description: nonEmpty(d.title, d.id), occurred_at: d.created_at ?? null });
    if (d.project_id && projectIds.has(d.project_id)) addEdge(`project:${d.project_id}`, did, 'contains');
    else addEdge(`workspace:${ws}`, did, 'contains');
    if (d.supersedes_id && docIds.has(d.supersedes_id)) addEdge(did, `document:${d.supersedes_id}`, 'derived_from');
    const h = (d.content_hash ?? '').trim();
    if (h) { const arr = docsByHash.get(h); if (arr) arr.push(did); else docsByHash.set(h, [did]); }
  }
  for (const ev of facts.evidenceLinks ?? []) {
    const h = (ev.content_hash ?? '').trim();
    if (!h) continue;
    for (const did of docsByHash.get(h) ?? []) {
      for (const target of [ev.packet_id ? `packet:${ev.packet_id}` : null, ev.event_id ? `event:${ev.event_id}` : null]) {
        if (target && seenNode.has(target)) addEdge(did, target, 'evidences');
      }
    }
  }

  // CAUSATION edges (effect → cause), from the caller-supplied causation map (audit_logs.causation_id).
  // A packet/decision points BACKWARD to the event/decision that caused it (PROV wasInformedBy direction).
  // Emit only when BOTH endpoints are real nodes in THIS workspace graph (tenant-scoped; no dangling edge).
  for (const c of facts.causation ?? []) {
    if (seenNode.has(c.effect) && seenNode.has(c.cause) && c.effect !== c.cause) addEdge(c.effect, c.cause, 'caused_by');
  }

  const node_count = nodes.length;
  const edge_count = edges.length;
  const snapshot: Omit<GraphSnapshot, 'generated_at'> = {
    schema_id: 'xlooop.data_graph_snapshot.v1',
    workspace_id: ws,
    graph_version: 1,
    graph_hash: computeGraphHash(nodes, edges),
    node_count,
    edge_count,
  };
  return { nodes, edges, snapshot };
}

/** Deterministic content hash of the graph (sorted node ids + sorted edge triples). Drift detector:
 *  a hash that differs from the facts' re-projection = a stale snapshot. djb2; no crypto dep. */
export function computeGraphHash(nodes: GraphNode[], edges: GraphEdge[]): string {
  // Material includes type + plane + the resolved domain_ref kind, not just timestamps — so a
  // node reclassified to a different plane/type/domain (e.g. event→governance) yields a NEW hash
  // (F10: a timestamp-only key was blind to those reclassifications).
  const nodeKeys = nodes
    .map((n) => `${n.id}|${n.type}|${n.plane ?? ''}|${n.domain_ref?.kind ?? ''}:${n.domain_ref?.id ?? ''}|${n.occurred_at ?? ''}|${n.ingested_at ?? ''}`)
    .sort();
  const edgeKeys = edges.map((e) => `${e.from}>${e.type}>${e.to}`).sort();
  const material = nodeKeys.join('\n') + '\n#\n' + edgeKeys.join('\n');
  let h = 5381;
  for (let i = 0; i < material.length; i++) h = ((h << 5) + h + material.charCodeAt(i)) >>> 0;
  return `dgh_${h.toString(16)}`;
}

// ── Causation / RCA traversal (PROV/OpenLineage-aligned) ──────────────────────
// The graph is the connective tissue: causation flows source → event → intent → decision/packet,
// walkable in BOTH directions. RCA (root-cause) = backward over the cause-edges to a root; impact
// (blast-radius) = forward. Pure functions over the edge list — the single source of RCA logic, reused
// by the verifier (HR-CAUSATION-TRACEABILITY-1) + the lineage route + the export digest.

export interface CauseTrace {
  start: string;
  visited: string[];   // node ids reached, in visitation order
  roots: string[];     // terminal nodes (no further cause-edge) — the root cause(s)
  cyclic: boolean;     // a cycle was detected → a HR-CAUSATION-TRACEABILITY-1 violation
  terminated: boolean; // acyclic AND reached at least one root
}

/** Walk the cause-edges from `startId`. direction='backward' (default) = RCA: follow
 *  {caused_by, realizes, derived_from} effect→cause to a root. direction='forward' = impact:
 *  follow the same edges cause→effect (reversed) to find everything `startId` ultimately affects. */
export function traceCause(edges: GraphEdge[], startId: string, direction: 'backward' | 'forward' = 'backward'): CauseTrace {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!CAUSE_EDGE_TYPES.has(e.type)) continue;
    const [from, to] = direction === 'backward' ? [e.from, e.to] : [e.to, e.from];
    const arr = adj.get(from); if (arr) arr.push(to); else adj.set(from, [to]);
  }
  const visited: string[] = [];
  const roots: string[] = [];
  const onPath = new Set<string>();
  const done = new Set<string>();
  let cyclic = false;
  const walk = (id: string) => {
    if (onPath.has(id)) { cyclic = true; return; } // back-edge on the active path = cycle
    if (done.has(id)) return;
    onPath.add(id); visited.push(id);
    const nexts = adj.get(id);
    if (!nexts || nexts.length === 0) { if (!roots.includes(id)) roots.push(id); }
    else for (const n of nexts) walk(n);
    onPath.delete(id); done.add(id);
  };
  walk(startId);
  return { start: startId, visited, roots, cyclic, terminated: !cyclic && roots.length > 0 };
}

/** Effect nodes that MUST have a resolvable cause (HR-CAUSATION-TRACEABILITY-1): a governance packet,
 *  or any node that already sits on a causal chain (has an incoming or outgoing cause-edge). A `source`
 *  node and a root `intent` (no derived_from) are legitimate ROOTS, never orphan effects. */
export function effectNodesRequiringCause(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const hasCauseEdgeFrom = new Set<string>();
  for (const e of edges) if (CAUSE_EDGE_TYPES.has(e.type)) hasCauseEdgeFrom.add(e.from);
  return nodes.filter((n) => n.type === 'packet' || (n.type === 'event' && hasCauseEdgeFrom.has(n.id)));
}
