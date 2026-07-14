-- 003_project_scope_binding.sql · R45 · 2026-05-28
--
-- Adds scope_binding JSONB to projects so each project can declare which
-- workspace events filter into its detail view.
--
-- Pre-R45 problem: project detail page showed "0 live scoped rows" with
-- no UI to fix it. Workspace-level event stream had 58 events; project
-- view filtered by `events.project_id = project.id` only — so events
-- emitted without a project_id (e.g. workspace-level activity, MCP-pushed
-- claude-session events) never filtered in.
--
-- Post-R45 model: scope_binding is an optional declarative filter. When
-- present, the API computes `events for this project` = events matching
-- ANY of:
--   1. events.project_id = projects.id (the existing direct-link path)
--   2. events.actor / source_tool / visibility matches the scope filters
--
-- Schema:
--   scope_binding JSONB shape (R45 v1):
--     {
--       "version": 1,
--       "combine": "any" | "all",
--       "filters": [
--         { "type": "actor_in", "values": ["claude-session-*"] },
--         { "type": "source_tool_in", "values": ["claude-code", "ci"] },
--         { "type": "status_in", "values": ["completed", "in-progress"] },
--         { "type": "visibility_in", "values": ["internal_workspace"] }
--       ]
--     }
--
-- NULL means "no binding configured" — project shows only directly-linked
-- events (existing R40 behavior · backward compatible).

BEGIN;

-- Idempotent ALTER (safe to re-run; checks current version first).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workers_schema_version WHERE version = 3
  ) THEN
    -- Add column if not already present
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'scope_binding'
    ) THEN
      ALTER TABLE projects ADD COLUMN scope_binding JSONB;
    END IF;

    -- Track who last updated the binding (admin/audit trail)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'scope_binding_updated_at'
    ) THEN
      ALTER TABLE projects ADD COLUMN scope_binding_updated_at TIMESTAMPTZ;
      ALTER TABLE projects ADD COLUMN scope_binding_updated_by TEXT;
    END IF;

    -- GIN index on scope_binding so future analytics can scan filters quickly
    CREATE INDEX IF NOT EXISTS idx_projects_scope_binding_gin
      ON projects USING GIN (scope_binding);

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (3, 'R45: project scope_binding JSONB column + GIN index', now());
  END IF;
END $$;

COMMIT;

-- Verification (run manually):
-- SELECT version, description, applied_at FROM workers_schema_version ORDER BY version;
-- \d+ projects
