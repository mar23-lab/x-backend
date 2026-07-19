-- 084_folder_snapshots_rls_policy.sql · STAGED ONLY, never auto-applied.
-- Wave M-B TASK 2 (260719) · close the last grant-parity exemption. 047 GRANTed SELECT on
-- folder_snapshots to the NOBYPASSRLS role xlooop_app but shipped NO policy (the read was argued
-- safe in prose because listProjectSourceBindingsRow LEFT JOINs it inside the workspace-GUC txn and
-- the direct baseline reads run on the OWNER connection). That prose exemption was the one remaining
-- entry in verify-rls-grant-parity.mjs's EXEMPT map — a security invariant enforced by a comment.
-- This migration replaces the prose with a policy: any read of folder_snapshots on the xlooop_app
-- connection is now constrained to the caller's workspace, matching board_cards / project_source_bindings.
--
-- SCOPING: folder_snapshots carries workspace_id TEXT directly (026 CREATE TABLE +
-- idx_folder_snapshots_workspace), so the policy scopes on workspace_id = xlooop_rls_workspace_id()
-- — the SAME single-value GUC shape as 043/045/046/047, NOT a parent project_id join. Rows with a
-- NULL workspace_id are (correctly) invisible under RLS on the app connection; the owner connection
-- bypasses RLS so getFolderBaselineRow / putFolderBaselineRow are unaffected.
--
-- SAFE / INERT: owner bypasses RLS; idempotent; version-guarded (84). Once applied, folder_snapshots
-- moves into the RLS-enabled set and the parity gate enforces it going forward (the EXEMPT entry is
-- removed in the same PR — a stale exemption would otherwise print a redundant-exemption note).
--
-- Apply MANUALLY (operator-applied, per repo policy — migrations are never auto-applied):
--   psql "$DATABASE_URL" -f src/workers/db/migrations/084_folder_snapshots_rls_policy.sql
--   -- or via Neon MCP on project flat-truth-23350426 after review.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 84) THEN
    -- Guard on the GUC helper (created in 047) so this is safe to run on any head >= 47.
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE folder_snapshots ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS folder_snapshots_workspace_policy ON folder_snapshots;
      CREATE POLICY folder_snapshots_workspace_policy ON folder_snapshots
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (84, 'folder_snapshots RLS workspace policy — closes the last grant-parity prose exemption (047 grant now policy-backed)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'folder_snapshots';
--   SELECT tablename, policyname FROM pg_policies WHERE tablename = 'folder_snapshots';
