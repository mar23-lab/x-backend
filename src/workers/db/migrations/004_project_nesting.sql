-- 004_project_nesting.sql · R47.3 · 2026-05-28
--
-- Adds projects.parent_project_id (self-referencing nullable foreign key) so
-- a project (= domain) can have child projects (= sub-domains). Enables the
-- operator to manage tree-structured domain catalogs · e.g. "Private domains"
-- as a parent under MB-P workspace with operator-defined children.
--
-- Constraints:
--   * parent_project_id, if non-NULL, must reference a project in the SAME
--     workspace (enforced by application-level check in createProject DAL)
--   * no cycles (DAL enforces; trigger could be added later if needed)

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 4) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'parent_project_id'
    ) THEN
      ALTER TABLE projects ADD COLUMN parent_project_id TEXT NULL
        REFERENCES projects(id) ON DELETE SET NULL;
    END IF;

    CREATE INDEX IF NOT EXISTS idx_projects_parent
      ON projects(parent_project_id) WHERE parent_project_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (4, 'R47.3: project nesting · parent_project_id self-ref + index', now());
  END IF;
END $$;

COMMIT;
