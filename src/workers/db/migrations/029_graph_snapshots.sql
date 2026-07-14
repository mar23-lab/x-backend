-- 029_graph_snapshots.sql · ADR-XLOOP-ARCH-003 Phase 2 · the data-graph's persisted home (closes C6) +
-- the lineage/causation spine (VI/VII) · 2026-06-10
--
-- WHY
--   R3 built `buildDataGraph` (a PURE projection over the relational facts) but it had ZERO production
--   callers — "a model with no home" (self-critique C6). This persists its output as a MATERIALIZED CACHE
--   of that pure function (NOT a second SSOT): the relational FK spine stays the only truth; graph_nodes/
--   graph_edges are reproducible by re-running buildDataGraph, and `graph_hash` proves freshness — the
--   same relationship a SQL VIEW has to its base tables, materialized for query speed
--   (HR-UNIFIED-GRAPH-DERIVED-1 / HR-PRODUCT-GRAPH-PROJECTION-1).
--
-- WHAT (additive, idempotent — no L0 mutation, no data rewrite)
--   * graph_snapshots — append-only time-series of (generated_at, graph_hash, counts) per workspace.
--                       The temporal + drift anchor: the latest row is the current graph's provenance;
--                       a fresh re-projection whose hash != the latest stored hash IS the drift flag.
--   * graph_nodes     — the CURRENT graph (replaced on rebuild, the drop-and-rebuild projection contract).
--                       node_type CHECK includes 'source' (the lineage origin, VI.2). `description` is the
--                       DERIVED label — descriptions are computed at projection time, NEVER stored on L0.
--   * graph_edges     — the CURRENT edges incl. `feeds` (source→project) + `caused_by` (effect→cause, the
--                       PROV/OpenLineage causation edge, VII). The cause-edges {caused_by,realizes,
--                       derived_from} are the RCA backbone (HR-CAUSATION-TRACEABILITY-1).
--   * v_artefact_lineage — the denormalized lineage spine VIEW: every edge joined to its from/to node
--                       descriptions + an `is_cause_edge` flag. SQL lives ONCE, reused by cockpit + export.
--                       The recursive RCA walk (why/impact) is performed by `traceCause()` in data-graph.ts
--                       (the single source of RCA logic, with cycle detection) or a `WITH RECURSIVE` query
--                       over this view — full transitive-closure materialization is deferred (sub-ms at
--                       our scale; revisit at 10^5–10^6 edges, VI.2).
--
-- APPLY (operator-gated, prod Neon is manual):
--   psql "$DATABASE_URL" -f src/workers/db/migrations/029_graph_snapshots.sql
-- `verify-prod-migrations.mjs` reports 029 apply-pending until the operator runs it against prod.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 29) THEN

    -- ── the temporal + drift anchor (append-only) ────────────────────────────
    CREATE TABLE IF NOT EXISTS graph_snapshots (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      graph_version INTEGER NOT NULL DEFAULT 1,
      graph_hash    TEXT NOT NULL,               -- computeGraphHash(nodes, edges) — drift detector
      node_count    INTEGER NOT NULL DEFAULT 0,
      edge_count    INTEGER NOT NULL DEFAULT 0,
      schema_id     TEXT NOT NULL DEFAULT 'xlooop.data_graph_snapshot.v1',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_graph_snapshots_ws_time ON graph_snapshots(workspace_id, generated_at DESC);

    -- ── the CURRENT graph (materialized cache; drop-and-rebuild per workspace) ─
    CREATE TABLE IF NOT EXISTS graph_nodes (
      workspace_id    TEXT NOT NULL,
      id              TEXT NOT NULL,             -- the node id, e.g. 'project:proj_123' | 'source:psb_1'
      node_type       TEXT NOT NULL
                        CHECK (node_type IN ('workspace','project','lens','intent','packet','event','source')),
      ref_id          TEXT NOT NULL,             -- the source row id
      label           TEXT,
      description     TEXT,                       -- DERIVED at projection (title/summary/source_ref); never on L0
      plane           TEXT,                       -- 'event_sourcing' | 'governance' | 'synthetic' (event/packet)
      occurred_at     TIMESTAMPTZ,                -- valid-time
      ingested_at     TIMESTAMPTZ,                -- transaction-time
      domain_ref_kind TEXT,                       -- 'lens' | 'life' | 'unknown' (typed domain resolver)
      domain_ref_id   TEXT,
      graph_hash      TEXT NOT NULL,              -- the snapshot this row belongs to
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_ws_type ON graph_nodes(workspace_id, node_type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_ref ON graph_nodes(workspace_id, ref_id);

    CREATE TABLE IF NOT EXISTS graph_edges (
      workspace_id  TEXT NOT NULL,
      edge_from     TEXT NOT NULL,
      edge_to       TEXT NOT NULL,
      edge_type     TEXT NOT NULL
                      CHECK (edge_type IN ('contains','views','scopes','derived_from','realizes','feeds','caused_by','governs')),
      graph_hash    TEXT NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, edge_from, edge_to, edge_type)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_edges_ws_from ON graph_edges(workspace_id, edge_from);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_ws_to ON graph_edges(workspace_id, edge_to);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_cause ON graph_edges(workspace_id, edge_type)
      WHERE edge_type IN ('caused_by','realizes','derived_from');

    -- ── the lineage spine VIEW (denormalized edges + descriptions; both directions) ──
    CREATE OR REPLACE VIEW v_artefact_lineage AS
      SELECT
        e.workspace_id,
        e.edge_from,
        nf.node_type    AS from_type,
        nf.description   AS from_description,
        e.edge_to,
        nt.node_type    AS to_type,
        nt.description   AS to_description,
        e.edge_type,
        (e.edge_type IN ('caused_by','realizes','derived_from')) AS is_cause_edge
      FROM graph_edges e
      LEFT JOIN graph_nodes nf ON nf.workspace_id = e.workspace_id AND nf.id = e.edge_from
      LEFT JOIN graph_nodes nt ON nt.workspace_id = e.workspace_id AND nt.id = e.edge_to;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (29, 'graph_snapshots/graph_nodes/graph_edges (data-graph persisted home) + v_artefact_lineage spine + caused_by/feeds/source (lineage+causation, additive)', now());
  END IF;
END $$;

COMMIT;
