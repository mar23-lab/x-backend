-- 083_customer_census_observations.sql · STAGED ONLY, never auto-applied.
-- J-E TASK 2 (260719) · persistence for the OBSERVE-only tenant sterility census
-- (crons/customer-census.ts + lib/customer-census.ts). Structural pattern mirrors
-- 077_current_work_parity_observations.sql: a customer-safe, append-only observation table that stores
-- ONLY counts and hashes — NO work ids, titles, prompts, or evidence content. It records, per workspace
-- per run, the population (events + intents + documents), the governed subset (attributed events + lineage
-- edges + intake_resolutions), and the orphan delta BY CLASS plus a stable hash of the orphan id SET
-- (so a changed orphan set is drift-detectable without persisting any id). The census OBSERVES; it never
-- remediates and this migration switches NO authority and flips NO flag.
--
-- Apply MANUALLY (operator-applied, per repo policy — migrations are never auto-applied):
--   psql "$DATABASE_URL" -f src/workers/db/migrations/083_customer_census_observations.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 83) THEN
    CREATE TABLE customer_census_observations (
      id                                TEXT PRIMARY KEY,
      workspace_id                      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      run_id                            TEXT NOT NULL,
      -- population (what the tenant produced)
      population_events                 INTEGER NOT NULL CHECK (population_events >= 0),
      population_intents                INTEGER NOT NULL CHECK (population_intents >= 0),
      population_documents              INTEGER NOT NULL CHECK (population_documents >= 0),
      population_total                  INTEGER NOT NULL CHECK (population_total >= 0),
      -- governed (what is attributed + connected + closed)
      governed_attributed_events        INTEGER NOT NULL CHECK (governed_attributed_events >= 0),
      governed_lineage_edges            INTEGER NOT NULL CHECK (governed_lineage_edges >= 0),
      governed_intake_resolutions       INTEGER NOT NULL CHECK (governed_intake_resolutions >= 0),
      governed_total                    INTEGER NOT NULL CHECK (governed_total >= 0),
      -- orphan delta, by class (the honest set-difference, not a subtracted cardinality)
      orphan_unattributed_events        INTEGER NOT NULL CHECK (orphan_unattributed_events >= 0),
      orphan_dangling_intents           INTEGER NOT NULL CHECK (orphan_dangling_intents >= 0),
      orphan_effect_nodes_without_cause INTEGER NOT NULL CHECK (orphan_effect_nodes_without_cause >= 0),
      orphan_missing_source_bindings    INTEGER NOT NULL CHECK (orphan_missing_source_bindings >= 0),
      orphan_total                      INTEGER NOT NULL CHECK (orphan_total >= 0),
      -- drift hashes (no ids persisted; the orphan SET is captured only as a hash)
      orphan_set_hash                   TEXT NOT NULL CHECK (orphan_set_hash ~ '^orh_[0-9a-f]+$'),
      graph_hash                        TEXT NOT NULL CHECK (graph_hash ~ '^dgh_[0-9a-f]+$'),
      created_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_customer_census_workspace
      ON customer_census_observations(workspace_id, created_at DESC);
    -- fast "which workspaces currently carry orphans" scan
    CREATE INDEX idx_customer_census_orphans
      ON customer_census_observations(created_at DESC)
      WHERE orphan_total > 0;

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE customer_census_observations ENABLE ROW LEVEL SECURITY;
      CREATE POLICY customer_census_observations_workspace_policy ON customer_census_observations
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
      GRANT SELECT, INSERT ON customer_census_observations TO xlooop_app;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (83, 'staged OBSERVE-only tenant sterility census observations (counts + hashes, customer-safe); no authority switch', now());
  END IF;
END $$;

COMMIT;
