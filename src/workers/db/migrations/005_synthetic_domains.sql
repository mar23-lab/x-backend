-- 005_synthetic_domains.sql · R49' · LEM-v3 foundation · 2026-05-28
--
-- Adds synthetic_domains as a first-class governed entity. A synthetic domain
-- is a derived membership view of projects (selected by a declarative binding)
-- that the operator manages independently — it has its own owner, governance,
-- audit trail, and (in LEM-v3 PR-3+) its own roadmap + goals + recommendation
-- surface.
--
-- LEM-v3 FORWARD-COMPATIBLE COLUMNS:
--   has_roadmap BOOLEAN, goal_count INT, open_recommendation_count INT
-- These are added at PR-1 (this migration) at zero cost so PR-3+ doesn't need
-- a backfill migration when roadmap / goal / recommendation tables land.
--
-- Binding shape (R49' v1) mirrors R45 scope_binding:
--   {
--     "version": 1,
--     "combine": "any" | "all",
--     "filters": [
--       { "type": "workspace_id_in",   "values": ["org_..."] },
--       { "type": "domain_id_in",      "values": ["domain:mbp-private:governance"] },
--       { "type": "parent_project_id_in", "values": ["proj_..."] },
--       { "type": "status_in",         "values": ["active", "paused"] },
--       { "type": "tag_in",            "values": ["commercial", "investor_facing"] },
--       { "type": "metadata_path",     "values": ["vertical=software_dev"] }
--     ]
--   }
--
-- Governance:
--   * workspace_id NULL = cross-workspace synthetic domain (visibility MUST be operator_only)
--   * owner_user_id is mandatory
--   * edit_role gates who can mutate the binding
--   * audit_logs row written on every binding change (DAL responsibility)
--
-- Materialized view `synthetic_domain_membership` is refreshed CONCURRENTLY
-- when bindings change OR when projects change. Refresh worker (PR-6) lands
-- in a later wave; for PR-1 the matview is created empty and refreshed on
-- explicit POST /synthetic-domains/:id/refresh-membership endpoint.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 5) THEN

    -- ============================================================
    -- synthetic_domains · the canonical entity
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'synthetic_domains'
    ) THEN
      CREATE TABLE synthetic_domains (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        slug TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        owner_user_id TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'workspace'
          CHECK (visibility IN ('operator_only','workspace','public_safe')),
        edit_role TEXT NOT NULL DEFAULT 'operator'
          CHECK (edit_role IN ('owner','operator','member')),
        binding JSONB NOT NULL,
        binding_version INT NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','paused','archived')),
        -- LEM-v3 forward-compat columns (PR-3+ populates these)
        has_roadmap BOOLEAN NOT NULL DEFAULT FALSE,
        goal_count INTEGER NOT NULL DEFAULT 0,
        open_recommendation_count INTEGER NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        binding_updated_at TIMESTAMPTZ,
        binding_updated_by TEXT,
        -- Cross-workspace synthetic domains MUST be operator_only visible
        CONSTRAINT chk_cross_workspace_operator_only
          CHECK (workspace_id IS NOT NULL OR visibility = 'operator_only')
      );

      CREATE UNIQUE INDEX idx_sd_workspace_slug
        ON synthetic_domains(COALESCE(workspace_id, '__cross__'), slug);
      CREATE INDEX idx_sd_owner ON synthetic_domains(owner_user_id);
      CREATE INDEX idx_sd_status_active
        ON synthetic_domains(workspace_id) WHERE status = 'active';
      CREATE INDEX idx_sd_binding_gin ON synthetic_domains USING GIN (binding);
    END IF;

    -- ============================================================
    -- synthetic_domain_membership · materialized view of derived membership
    -- ============================================================
    -- Note: actual binding evaluation lives in the DAL (TypeScript) because
    -- the filter dim set is extensible. The matview is populated by an
    -- INSERT … FROM evaluate_binding(domain, project) … call from the DAL
    -- on binding edit OR via the propagation worker (PR-6).
    --
    -- For PR-1 we ship an EMPTY matview with the correct shape; the DAL's
    -- `refreshDomainMembership(domainId)` method populates it on each
    -- binding edit. Future PR-6 worker refreshes all domains on a 60s tick.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = 'synthetic_domain_membership' AND relkind = 'r'
    ) THEN
      -- Use a plain table (not a matview) so the DAL can INSERT/DELETE per
      -- domain selectively without REFRESH MATERIALIZED VIEW's full-rewrite
      -- cost. The shape mirrors a matview and is documented as one.
      CREATE TABLE synthetic_domain_membership (
        domain_id TEXT NOT NULL REFERENCES synthetic_domains(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (domain_id, project_id)
      );
      CREATE INDEX idx_sdm_project ON synthetic_domain_membership(project_id);
      CREATE INDEX idx_sdm_workspace ON synthetic_domain_membership(workspace_id);
    END IF;

    -- ============================================================
    -- audit_logs.target_type expansion: add 'synthetic_domain' + 'project'
    -- ============================================================
    -- The existing audit_logs.action CHECK is a permissive regex
    -- (`^[a-z_]+$`) so new synthetic_domain_* action values pass without
    -- constraint change. target_type is a value list and needs expansion.
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'audit_logs_target_type_check'
        AND table_name = 'audit_logs'
    ) THEN
      ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_target_type_check;
    END IF;
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_target_type_check CHECK (target_type IN (
      'user','workspace_member','access_request','workspace','project','synthetic_domain'
    ));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (5, 'R49: synthetic_domains + membership table + LEM-v3 forward-compat columns + audit action expansion', now());
  END IF;
END $$;

COMMIT;

-- Verification (run manually):
-- SELECT version, description, applied_at FROM workers_schema_version ORDER BY version;
-- \d+ synthetic_domains
-- \d+ synthetic_domain_membership
