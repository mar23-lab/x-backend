-- 033_project_source_domain_link.sql · W1'-PR4 (ADR-V3-026)
--
-- WHY
--   Knowledge sources (Drive / GitHub / Dropbox / desktop folder) bind to a PROJECT today
--   (project_source_bindings, migration 016). W1' adds self-serve "connect a source to a
--   DOMAIN" — the operator's mental model is sources → domains (context-lenses), per 028's
--   "connect-a-source auto-links by context". This records the domain a binding is attached to.
--
-- WHAT (additive, idempotent — no L0 mutation, no backfill)
--   * domain_id — nullable backref to the synthetic_domains lens this source feeds. NULL for the
--                 prior project-only bindings (unchanged). When set, the Workspace "Domains +
--                 sources" surface shows the source under its domain. Tenant-safe (a customer sees
--                 which of THEIR domains a source feeds); no IP boundary concern.
--
-- APPLY: prod Neon migrations are applied MANUALLY (operator-gated), same as 028. The committed DAL
--        references domain_id (consistent with synthetic-domain-store.ts referencing 028's columns);
--        it runs against a DB only after this migration is applied there. `verify-prod-migrations.mjs`
--        reports 033 as apply-pending until the operator runs it against prod.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 33) THEN

    ALTER TABLE project_source_bindings
      ADD COLUMN IF NOT EXISTS domain_id TEXT NULL;

    COMMENT ON COLUMN project_source_bindings.domain_id IS
      'W1''-PR4 (ADR-V3-026) · nullable backref to the synthetic_domains lens this source feeds. NULL = project-only binding (prior behaviour). Tenant-safe.';

    CREATE INDEX IF NOT EXISTS idx_project_source_bindings_domain
      ON project_source_bindings(workspace_id, domain_id)
      WHERE domain_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (33, 'W1''-PR4 · project_source_bindings.domain_id — connect-a-source to a domain lens (additive)', now());
  END IF;
END $$;

COMMIT;
