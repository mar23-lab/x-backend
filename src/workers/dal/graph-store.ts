// graph-store.ts · ADR-XLOOP-ARCH-003 Phase 2 · the data-graph's persistence + facts-assembly DAL.
//
// This is the bridge that gives `buildDataGraph` (a PURE projection, src/workers/graph/data-graph.ts) its
// FIRST real production home (closes self-critique C6). It does the impure I/O the pure builder cannot:
//   1. assembleDataGraphFactsRow — read the relational facts (the facts-JOIN lives HERE: operations_unified
//      carries plane+domain_id but NOT intent_id, so it LEFT JOINs operation_events to pull intent_id —
//      ADR-ARCH-003 VI.2 step 3).
//   2. replaceWorkspaceGraphRow — drop-and-rebuild the materialized graph for one workspace (the projection
//      contract: graph_* is a CACHE of the pure function, never a 2nd SSOT) + append the snapshot.
//   3. getLatestGraphSnapshotRow — the drift anchor (a fresh re-projection whose hash != this = drift).
//   4. getArtefactLineageRow — read the v_artefact_lineage spine (the cockpit/export retrieval surface).
//
// Tenant-scoped on every query (workspace_id). No L0 mutation — reads facts, writes only the derived graph.

import type { Sql } from '../db/client';
import type { DataGraphFacts, GraphNode, GraphEdge } from '../graph/data-graph';

const str = (v: unknown): string => (v == null ? '' : String(v));
const orNull = (v: unknown): string | null => (v == null || String(v) === '' ? null : String(v));
const iso = (v: unknown): string | null => { try { return v ? new Date(v as string).toISOString() : null; } catch { return null; } };

/** Read the relational facts for ONE workspace into the shape buildDataGraph consumes. The facts-JOIN
 *  (operations_unified ⨝ operation_events for intent_id) happens here. Bounded by LIMITs (our scale is
 *  low-thousands of events; revisit pagination at 10^5+). */
export async function assembleDataGraphFactsRow(sql: Sql, workspaceId: string, opts: { includeDocuments?: boolean } = {}): Promise<DataGraphFacts> {
  const ws = str(workspaceId);

  const wsRows = (await sql/*sql*/`
    SELECT id, COALESCE(config->>'name', config->>'display_name', config->>'label') AS name
    FROM workspaces WHERE id = ${ws} LIMIT 1
  `) as Array<Record<string, unknown>>;

  const projectRows = (await sql/*sql*/`
    SELECT id, workspace_id, name, description, status, parent_project_id, created_at
    FROM projects WHERE workspace_id = ${ws}
  `) as Array<Record<string, unknown>>;

  const lensRows = (await sql/*sql*/`
    SELECT id, workspace_id, slug, label, description, created_at
    FROM synthetic_domains WHERE workspace_id = ${ws} AND status <> 'archived'
  `) as Array<Record<string, unknown>>;

  const membershipRows = (await sql/*sql*/`
    SELECT domain_id, project_id FROM synthetic_domain_membership WHERE workspace_id = ${ws}
  `) as Array<Record<string, unknown>>;

  const intentRows = (await sql/*sql*/`
    SELECT id, workspace_id, project_id, domain_id, title, derived_from, created_at
    FROM intents WHERE workspace_id = ${ws}
  `) as Array<Record<string, unknown>>;

  // D1 fix (ARCH-004 VIII.2): drive the event-plane off operation_events (the REAL fact table — 4159
  // rows with project_id + intent_id), NOT operations_unified (a partial Wave-5a mirror that on prod
  // holds only ~71 governance rows). Reading operations_unified alone projected ~1.7% of events.
  // We UNION the governance/synthetic packets from operations_unified (the planes operation_events
  // does NOT carry). No double-count: event-plane rows come ONLY from operation_events; we exclude
  // u.plane='event_sourcing'. operation_events carries occurred_at/ingested_at/domain_id/intent_id/
  // project_id directly, so the facts-JOIN is no longer needed for intent_id.
  const unifiedRows = (await sql/*sql*/`
    SELECT id, plane, source_plane_id, workspace_id, project_id, domain_id, kind, occurred_at, ingested_at, summary, title, intent_id
    FROM (
      SELECT e.id AS id, 'event_sourcing'::text AS plane, e.id AS source_plane_id, e.workspace_id, e.project_id, e.domain_id,
             COALESCE(NULLIF(e.source_tool, ''), 'event') AS kind, e.occurred_at, e.ingested_at, e.summary, NULL::text AS title, e.intent_id
      FROM operation_events e WHERE e.workspace_id = ${ws}
      UNION ALL
      SELECT u.id, u.plane, u.source_plane_id, u.workspace_id, u.project_id, u.domain_id, u.kind,
             u.occurred_at, u.ingested_at, u.summary, u.title, NULL::text AS intent_id
      FROM operations_unified u WHERE u.workspace_id = ${ws} AND u.plane <> 'event_sourcing'
    ) t
    ORDER BY occurred_at DESC NULLS LAST
    LIMIT 5000
  `) as Array<Record<string, unknown>>;

  const bindingRows = (await sql/*sql*/`
    SELECT id, workspace_id, project_id, source_kind, source_ref, created_at
    FROM project_source_bindings WHERE workspace_id = ${ws} AND status <> 'archived'
  `) as Array<Record<string, unknown>>;

  // causation pairs from audit_logs.causation_id. We propose CANDIDATE node-id pairs; buildDataGraph
  // emits the edge ONLY when both endpoints resolve to real nodes in this workspace graph (no fabricated
  // or dangling edge — the C3 fake-strip honesty lesson). The audit target is the EFFECT (a governance
  // packet/decision); the causation_id is the CAUSE (the event/intent/decision that triggered it).
  const auditRows = (await sql/*sql*/`
    SELECT target_type, target_id, causation_id
    FROM audit_logs WHERE workspace_id = ${ws} AND causation_id IS NOT NULL
    LIMIT 5000
  `) as Array<Record<string, unknown>>;

  const causation: Array<{ effect: string; cause: string }> = [];
  for (const a of auditRows) {
    const tid = orNull(a.target_id); const cid = orNull(a.causation_id);
    if (!tid || !cid) continue;
    const ttype = str(a.target_type).toLowerCase();
    const effectIds = ttype === 'event' ? [`event:${tid}`] : [`packet:${tid}`, `event:${tid}`];
    const causeIds = [`event:${cid}`, `intent:${cid}`, `packet:${cid}`];
    for (const e of effectIds) for (const c of causeIds) causation.push({ effect: e, cause: c });
  }

  // W3 (260708) · documents as lineage nodes — flag-gated HERE (not in the pure builder) so the graph_hash
  // stays byte-stable while GRAPH_DOCUMENT_NODES_ENABLED is off (drift gate honesty). Degrade-safe: pre-051
  // schemas return [] rather than failing the whole rebuild.
  let documentRows: Array<Record<string, unknown>> = [];
  let evidenceRows: Array<Record<string, unknown>> = [];
  if (opts.includeDocuments) {
    try {
      documentRows = (await sql/*sql*/`
        SELECT id, workspace_id, project_id, title, content_hash, supersedes_id, created_at
        FROM documents WHERE workspace_id = ${ws}
        ORDER BY created_at DESC NULLS LAST LIMIT 2000
      `) as Array<Record<string, unknown>>;
      evidenceRows = (await sql/*sql*/`
        SELECT content_hash, packet_id, event_id
        FROM evidence_items WHERE workspace_id = ${ws} AND content_hash IS NOT NULL
        LIMIT 5000
      `) as Array<Record<string, unknown>>;
    } catch { documentRows = []; evidenceRows = []; }
  }

  return {
    workspaces: wsRows.map((r) => ({ id: str(r.id), name: orNull(r.name) })),
    projects: projectRows.map((r) => ({ id: str(r.id), workspace_id: str(r.workspace_id), name: orNull(r.name), description: orNull(r.description), status: orNull(r.status), parent_project_id: orNull(r.parent_project_id), created_at: iso(r.created_at) })),
    lenses: lensRows.map((r) => ({ id: str(r.id), workspace_id: orNull(r.workspace_id), slug: orNull(r.slug), label: orNull(r.label), created_at: iso(r.created_at) })),
    memberships: membershipRows.map((r) => ({ domain_id: str(r.domain_id), project_id: str(r.project_id) })),
    intents: intentRows.map((r) => ({ id: str(r.id), workspace_id: orNull(r.workspace_id), project_id: orNull(r.project_id), domain_id: orNull(r.domain_id), derived_from: orNull(r.derived_from), title: orNull(r.title), created_at: iso(r.created_at) })),
    unified: unifiedRows.map((r) => ({ id: str(r.id), plane: str(r.plane) as DataGraphFacts['unified'][number]['plane'], source_plane_id: orNull(r.source_plane_id), workspace_id: orNull(r.workspace_id), project_id: orNull(r.project_id), domain_id: orNull(r.domain_id), kind: orNull(r.kind), occurred_at: iso(r.occurred_at), ingested_at: iso(r.ingested_at), summary: orNull(r.summary), title: orNull(r.title), intent_id: orNull(r.intent_id) })),
    bindings: bindingRows.map((r) => ({ id: str(r.id), workspace_id: orNull(r.workspace_id), project_id: orNull(r.project_id), source_kind: orNull(r.source_kind), source_ref: r.source_ref, created_at: iso(r.created_at) })),
    causation,
    ...(opts.includeDocuments ? {
      documents: documentRows.map((r) => ({ id: str(r.id), workspace_id: orNull(r.workspace_id), project_id: orNull(r.project_id), title: orNull(r.title), content_hash: orNull(r.content_hash), supersedes_id: orNull(r.supersedes_id), created_at: iso(r.created_at) })),
      evidenceLinks: evidenceRows.map((r) => ({ content_hash: orNull(r.content_hash), packet_id: orNull(r.packet_id), event_id: orNull(r.event_id) })),
    } : {}),
  };
}

export interface GraphSnapshotRow {
  workspace_id: string; generated_at: string; graph_version: number; graph_hash: string; node_count: number; edge_count: number;
}

/** Drop-and-rebuild the materialized graph for one workspace + append the snapshot — one transaction.
 *  The projection contract: the graph is fully replaced from the fresh facts (never incrementally
 *  patched), so it can never drift. Bulk INSERT via unnest (the house pattern). */
export async function replaceWorkspaceGraphRow(
  sql: Sql, workspaceId: string, nodes: GraphNode[], edges: GraphEdge[],
  meta: { graph_hash: string; graph_version: number; node_count: number; edge_count: number }, generatedAtIso: string,
): Promise<void> {
  const ws = str(workspaceId);
  const ids = nodes.map((n) => n.id);
  const types = nodes.map((n) => n.type);
  const refIds = nodes.map((n) => n.ref_id);
  const labels = nodes.map((n) => orNull(n.label));
  const descs = nodes.map((n) => orNull(n.description));
  const planes = nodes.map((n) => orNull(n.plane));
  const occ = nodes.map((n) => orNull(n.occurred_at));
  const ing = nodes.map((n) => orNull(n.ingested_at));
  const dk = nodes.map((n) => orNull(n.domain_ref?.kind));
  const di = nodes.map((n) => orNull(n.domain_ref?.id));
  const eFrom = edges.map((e) => e.from);
  const eTo = edges.map((e) => e.to);
  const eType = edges.map((e) => e.type);

  const stmts: unknown[] = [
    sql/*sql*/`DELETE FROM graph_nodes WHERE workspace_id = ${ws}`,
    sql/*sql*/`DELETE FROM graph_edges WHERE workspace_id = ${ws}`,
    sql/*sql*/`
      INSERT INTO graph_nodes (workspace_id, id, node_type, ref_id, label, description, plane, occurred_at, ingested_at, domain_ref_kind, domain_ref_id, graph_hash)
      SELECT ${ws}, t.id, t.node_type, t.ref_id, t.label, t.description, t.plane,
             t.occurred_at::timestamptz, t.ingested_at::timestamptz, t.domain_ref_kind, t.domain_ref_id, ${meta.graph_hash}
      FROM unnest(${ids}::text[], ${types}::text[], ${refIds}::text[], ${labels}::text[], ${descs}::text[],
                  ${planes}::text[], ${occ}::text[], ${ing}::text[], ${dk}::text[], ${di}::text[])
        AS t(id, node_type, ref_id, label, description, plane, occurred_at, ingested_at, domain_ref_kind, domain_ref_id)
    `,
    sql/*sql*/`
      INSERT INTO graph_edges (workspace_id, edge_from, edge_to, edge_type, graph_hash)
      SELECT ${ws}, t.edge_from, t.edge_to, t.edge_type, ${meta.graph_hash}
      FROM unnest(${eFrom}::text[], ${eTo}::text[], ${eType}::text[]) AS t(edge_from, edge_to, edge_type)
      ON CONFLICT (workspace_id, edge_from, edge_to, edge_type) DO NOTHING
    `,
    sql/*sql*/`
      INSERT INTO graph_snapshots (workspace_id, generated_at, graph_version, graph_hash, node_count, edge_count, schema_id)
      VALUES (${ws}, ${generatedAtIso}::timestamptz, ${meta.graph_version}, ${meta.graph_hash}, ${meta.node_count}, ${meta.edge_count}, 'xlooop.data_graph_snapshot.v1')
    `,
  ];
  await (sql as unknown as { transaction: (q: unknown[]) => Promise<unknown> }).transaction(stmts);
}

/** The latest persisted snapshot for a workspace (the drift anchor). null if the graph was never built. */
export async function getLatestGraphSnapshotRow(sql: Sql, workspaceId: string): Promise<GraphSnapshotRow | null> {
  const rows = (await sql/*sql*/`
    SELECT workspace_id, generated_at, graph_version, graph_hash, node_count, edge_count
    FROM graph_snapshots WHERE workspace_id = ${str(workspaceId)}
    ORDER BY generated_at DESC LIMIT 1
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const r = rows[0];
  return { workspace_id: str(r.workspace_id), generated_at: iso(r.generated_at) || '', graph_version: Number(r.graph_version) || 1, graph_hash: str(r.graph_hash), node_count: Number(r.node_count) || 0, edge_count: Number(r.edge_count) || 0 };
}

export interface LineageEdgeRow {
  edge_from: string; from_type: string | null; from_description: string | null;
  edge_to: string; to_type: string | null; to_description: string | null;
  edge_type: string; is_cause_edge: boolean;
}

/** Read the v_artefact_lineage spine for a workspace, optionally anchored at one node (either endpoint). */
export async function getArtefactLineageRow(sql: Sql, workspaceId: string, opts?: { nodeId?: string; causeOnly?: boolean }): Promise<LineageEdgeRow[]> {
  const ws = str(workspaceId);
  const node = opts?.nodeId ? str(opts.nodeId) : null;
  const causeOnly = opts?.causeOnly === true;
  const rows = (await sql/*sql*/`
    SELECT workspace_id, edge_from, from_type, from_description, edge_to, to_type, to_description, edge_type, is_cause_edge
    FROM v_artefact_lineage
    WHERE workspace_id = ${ws}
      AND (${node}::text IS NULL OR edge_from = ${node}::text OR edge_to = ${node}::text)
      AND (${causeOnly} = false OR is_cause_edge = true)
    LIMIT 5000
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    edge_from: str(r.edge_from), from_type: orNull(r.from_type), from_description: orNull(r.from_description),
    edge_to: str(r.edge_to), to_type: orNull(r.to_type), to_description: orNull(r.to_description),
    edge_type: str(r.edge_type), is_cause_edge: r.is_cause_edge === true,
  }));
}
