-- 089_workspace_charter_grant.sql · STAGED ONLY, never auto-applied · Wave 1 PR-1b.
-- The charter READ path (getCharterRow) runs on the RLS-subject app connection (WorkersDalAdapter.rlsSql),
-- matching listEvents/listProjects. mig 088 shipped workspace_charter with RLS ENABLED but NO xlooop_app
-- grant (RLS-before-grant / PART-AE doctrine), so the app role cannot SELECT it yet. This grant closes
-- that — SELECT ONLY (writes go through the OWNER connection in upsertCharterRow, which bypasses RLS/grants).
--
-- PARITY-SAFE BY CONSTRUCTION: 088 already ENABLE ROW LEVEL SECURITY + the workspace policy, so this grant
-- satisfies verify-rls-grant-parity (grant subset of RLS-enabled) the moment it lands. Any app-connection
-- read is constrained to the caller's workspace by the 088 policy. Apply 088 THEN 089 (this file assumes 088).
--
-- Verified on throwaway Neon branch (088+089 applied): app-role SELECT on workspace_charter is
-- workspace-scoped (cross-workspace read -> 0 rows); owner writes unaffected.
--
-- Apply MANUALLY (operator-applied) together with 088.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 89) THEN
    -- Only if the RLS-subject role exists (prod); byte-identical no-op in single-role dev.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
      GRANT SELECT ON workspace_charter TO xlooop_app;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (89, 'W1-PR1b: GRANT SELECT ON workspace_charter TO xlooop_app (read path = RLS-subject connection). Parity-safe — 088 already enabled RLS + policy. Writes stay on the owner connection.', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name='workspace_charter';  -- xlooop_app / SELECT
