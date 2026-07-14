-- 069_smart_er_goal_schema.sql · SE-1 (260713) · first-class SMART-ER goal object — STAGED.
--
-- WHY (ADR: plan v3 SE track, operator-approved 260713; design §227 "v1.1 first-class goal object").
-- MB-P (customer-zero) authors goals as a full SMART-ER contract (<domain>/_ops/GOALS.md: tier, ikigai
-- axes, metric baseline/target, warn/block thresholds, scorer/verifier, evidence_refs, review_trigger,
-- reinforces/conflicts edges — enforced >=95% by verify_goal_metric_lineage_contract.py). The product
-- carried only a title: synthetic_domain_goals has the metric SPINE (mig 006: metric_name/unit/current/
-- target/target_date + goal_progress) but no typed -ER/governance layer, no goal relationships, and the
-- data graph (mig 029) excludes goal/roadmap node types entirely. This migration adds the missing layer
-- so Xlooop can carry the architecture for the operator AND for new customers (SE-4 authoring).
--
-- SHAPE (ratified): typed columns for fields that earn indexing/rendering/gating; one JSONB for the
-- free-form contract sub-object; a first-class relationships table; graph vocab extension.
-- Additive-only; no data rewrite; reversible (DROP COLUMN/TABLE; CHECKs restored from 029 literals).
-- Validate on a Neon branch BEFORE prod; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 69) THEN

    -- (A) SMART-ER typed layer on goals ------------------------------------------------------------
    ALTER TABLE synthetic_domain_goals
      ADD COLUMN IF NOT EXISTS tier TEXT
        CHECK (tier IS NULL OR tier IN ('T0','T1','T2','T3')),
      ADD COLUMN IF NOT EXISTS ikigai_axes TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS future_state TEXT
        CHECK (future_state IS NULL OR future_state IN ('keep','upgrade','demote','refactor','sunset','promote')),
      ADD COLUMN IF NOT EXISTS review_cadence TEXT,
      ADD COLUMN IF NOT EXISTS review_due DATE,
      ADD COLUMN IF NOT EXISTS source_goal_id TEXT,           -- MB-P G-* id (bridge lineage/parity key)
      ADD COLUMN IF NOT EXISTS goal_metric_contract JSONB;    -- {current_baseline, target_delta,
                                                              --  thresholds:{warn,block}, scorer_or_verifier,
                                                              --  evidence_refs:[], review_trigger}

    -- bridge parity + review scheduling lookups
    CREATE INDEX IF NOT EXISTS idx_sdg_source_goal ON synthetic_domain_goals(source_goal_id)
      WHERE source_goal_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sdg_review_due ON synthetic_domain_goals(review_due)
      WHERE review_due IS NOT NULL;

    -- (B) goal relationships (reinforces/conflicts graph, GOALS_REGISTRY cross-links) ---------------
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'synthetic_domain_goal_relationships'
    ) THEN
      CREATE TABLE synthetic_domain_goal_relationships (
        id TEXT PRIMARY KEY,
        from_goal_id TEXT NOT NULL REFERENCES synthetic_domain_goals(id) ON DELETE CASCADE,
        to_goal_id TEXT NOT NULL,          -- may reference a not-yet-synced goal (loose by design;
                                           -- Sentinel goals-plane reports dangling targets)
        kind TEXT NOT NULL
          CHECK (kind IN ('reinforces','conflicts_with','unlocks','blocked_by','depends_on')),
        workspace_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_sdgr_edge ON synthetic_domain_goal_relationships(from_goal_id, to_goal_id, kind);
      CREATE INDEX idx_sdgr_from ON synthetic_domain_goal_relationships(from_goal_id);
    END IF;

    -- (C) graph vocabulary: goals + roadmaps become first-class graph citizens ----------------------
    -- (029:58/79 CHECKs; recreate with the extended literal sets — additive supersets.)
    ALTER TABLE graph_nodes DROP CONSTRAINT IF EXISTS graph_nodes_node_type_check;
    ALTER TABLE graph_nodes ADD CONSTRAINT graph_nodes_node_type_check
      CHECK (node_type IN ('workspace','project','lens','intent','packet','event','source','goal','roadmap'));

    ALTER TABLE graph_edges DROP CONSTRAINT IF EXISTS graph_edges_edge_type_check;
    ALTER TABLE graph_edges ADD CONSTRAINT graph_edges_edge_type_check
      CHECK (edge_type IN ('contains','views','scopes','derived_from','realizes','feeds','caused_by','governs',
                           'supports_goal','reinforces','conflicts_with'));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (69, 'SMART-ER goal object: tier/ikigai/future_state/review_cadence/review_due/source_goal_id/goal_metric_contract on synthetic_domain_goals; synthetic_domain_goal_relationships table; graph node/edge vocab admits goal+roadmap (SE-1, plan v3 SE track)', now());
  END IF;
END $$;

COMMIT;
