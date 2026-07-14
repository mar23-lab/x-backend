-- 006_synthetic_domain_planning.sql · R49' LEM-v3 PR-3 · 2026-05-28
--
-- Adds the planning layer on top of R49' synthetic_domains:
--   * synthetic_domain_roadmaps      · ordered sequences of work for a domain
--   * synthetic_domain_roadmap_items · individual items in a roadmap
--   * synthetic_domain_goals         · measurable targets (with derived current_value)
--   * synthetic_domain_goal_progress · time-series observations of goal current_value
--
-- Forward-compat columns on synthetic_domains (has_roadmap, goal_count,
-- open_recommendation_count) were already added in migration 005. Triggers
-- and DAL methods maintain these counters as roadmaps/goals/recommendations
-- mutate.
--
-- All tables:
--   * cascade-delete on synthetic_domains.id removal (children die with parent)
--   * denormalize domain_id + workspace_id for query speed + tenancy
--   * include created_by / updated_by + timestamps for audit
--
-- The recommendation layer (synthetic_domain_propagation_rules +
-- synthetic_domain_recommendations) lands in PR-5 / PR-6, not here.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 6) THEN

    -- ============================================================
    -- synthetic_domain_roadmaps · ordered work sequence per domain
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'synthetic_domain_roadmaps'
    ) THEN
      CREATE TABLE synthetic_domain_roadmaps (
        id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL REFERENCES synthetic_domains(id) ON DELETE CASCADE,
        workspace_id TEXT,   -- denormalised (mirrors domain.workspace_id; nullable for cross-workspace)
        title TEXT NOT NULL,
        description TEXT,
        target_date DATE,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft','active','completed','paused','archived')),
        version INTEGER NOT NULL DEFAULT 1,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by TEXT NOT NULL,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_sdr_domain ON synthetic_domain_roadmaps(domain_id);
      CREATE INDEX idx_sdr_status ON synthetic_domain_roadmaps(status) WHERE status IN ('draft','active');
      CREATE INDEX idx_sdr_workspace ON synthetic_domain_roadmaps(workspace_id);
    END IF;

    -- ============================================================
    -- synthetic_domain_roadmap_items · ordered children of a roadmap
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'synthetic_domain_roadmap_items'
    ) THEN
      CREATE TABLE synthetic_domain_roadmap_items (
        id TEXT PRIMARY KEY,
        roadmap_id TEXT NOT NULL REFERENCES synthetic_domain_roadmaps(id) ON DELETE CASCADE,
        domain_id TEXT NOT NULL,             -- denormalised
        position INTEGER NOT NULL,           -- ordered sequence (0-indexed)
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'planned'
          CHECK (status IN ('planned','in_progress','blocked','done','skipped')),
        target_date DATE,
        derived_from_project_id TEXT,        -- nullable FK to projects (no constraint to allow archival)
        derived_from_event_id TEXT,          -- nullable FK to operation_events
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_sdri_roadmap_pos ON synthetic_domain_roadmap_items(roadmap_id, position);
      CREATE INDEX idx_sdri_domain ON synthetic_domain_roadmap_items(domain_id);
      CREATE INDEX idx_sdri_status ON synthetic_domain_roadmap_items(status);
    END IF;

    -- ============================================================
    -- synthetic_domain_goals · measurable targets
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'synthetic_domain_goals'
    ) THEN
      CREATE TABLE synthetic_domain_goals (
        id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL REFERENCES synthetic_domains(id) ON DELETE CASCADE,
        roadmap_id TEXT REFERENCES synthetic_domain_roadmaps(id) ON DELETE SET NULL,
        workspace_id TEXT,                   -- denormalised
        title TEXT NOT NULL,
        description TEXT,
        metric_name TEXT NOT NULL,           -- 'member_project_count', 'event_count_completed', 'sign_off_approved_count'
        metric_unit TEXT,                    -- 'count', 'percent', 'days'
        target_value NUMERIC NOT NULL,
        current_value NUMERIC,
        current_value_updated_at TIMESTAMPTZ,
        target_date DATE,
        status TEXT NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed','active','achieved','abandoned')),
        derivation JSONB NOT NULL,           -- { kind: 'member_project_count' | 'project_status_count' | 'event_count', filter: {...} }
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by TEXT NOT NULL,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_sdg_domain ON synthetic_domain_goals(domain_id);
      CREATE INDEX idx_sdg_roadmap ON synthetic_domain_goals(roadmap_id) WHERE roadmap_id IS NOT NULL;
      CREATE INDEX idx_sdg_status_active ON synthetic_domain_goals(domain_id) WHERE status IN ('proposed','active');
    END IF;

    -- ============================================================
    -- synthetic_domain_goal_progress · time-series of current_value
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'synthetic_domain_goal_progress'
    ) THEN
      CREATE TABLE synthetic_domain_goal_progress (
        goal_id TEXT NOT NULL REFERENCES synthetic_domain_goals(id) ON DELETE CASCADE,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        value NUMERIC NOT NULL,
        source_signal_id TEXT,               -- nullable operation_events.id
        PRIMARY KEY (goal_id, observed_at)
      );
      CREATE INDEX idx_sdgp_goal ON synthetic_domain_goal_progress(goal_id, observed_at DESC);
    END IF;

    -- ============================================================
    -- audit_logs.target_type expansion: add roadmap + goal + recommendation
    -- ============================================================
    -- recommendation is forward-compat for PR-6; we add it now to avoid
    -- another migration on the same table.
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'audit_logs_target_type_check'
        AND table_name = 'audit_logs'
    ) THEN
      ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_target_type_check;
    END IF;
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_target_type_check CHECK (target_type IN (
      'user','workspace_member','access_request','workspace','project',
      'synthetic_domain',
      'synthetic_domain_roadmap','synthetic_domain_roadmap_item',
      'synthetic_domain_goal','synthetic_domain_propagation_rule','synthetic_domain_recommendation'
    ));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (6, 'R49 PR-3: synthetic_domain_roadmaps + _roadmap_items + _goals + _goal_progress · LEM-v3 planning layer', now());
  END IF;
END $$;

COMMIT;

-- Verification:
-- SELECT version, description FROM workers_schema_version ORDER BY version;
-- \d+ synthetic_domain_roadmaps
-- \d+ synthetic_domain_roadmap_items
-- \d+ synthetic_domain_goals
-- \d+ synthetic_domain_goal_progress
