-- 047_board_cards_source_bindings_rls.sql · RLS defense-in-depth increment — board_cards +
-- project_source_bindings (customer-owned).
--
-- WHY: continues the per-table RLS cutover (034 spine, 043 operation_events, 045 projects,
-- 046 documents). Both tables are customer-visible, workspace_id-scoped, and their LIST reads are
-- single-workspace + DAL-method-only — the exact 043 recipe.
--
-- SCOPE NOTES (grounded read-path audit, 260706):
--   * board_cards · listBoardCardsRow (governance-store.ts) — clean single-table read → routed.
--   * project_source_bindings · listProjectSourceBindingsRow (project-store.ts) — additive
--     LEFT JOIN folder_snapshots (file-count/synced-at enrichment) → routed with the join inside the
--     GUC transaction; folder_snapshots therefore gets a SELECT GRANT here. folder_snapshots is
--     grant-only this increment (no policy yet — rows are reachable only via the workspace-scoped
--     binding join; a dedicated policy is a later increment).
--   * decisions / intents — DELIBERATELY NOT ROUTED: their reads are multi-workspace
--     operator-overlay (`workspace_id = ANY(owned)`), which the single-value workspace GUC cannot
--     express; routing would break operator visibility. They are operator governance artifacts.
--     DB-layer protection for them would be an operator-id-based policy design (separate increment).
--
-- SAFE / INERT-UNTIL-WIRED: owner bypasses RLS. Idempotent + version-guarded. Apply MANUALLY (operator-named).

CREATE OR REPLACE FUNCTION xlooop_rls_workspace_id()
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('xlooop.current_workspace_id', true), '')
$$;

GRANT USAGE ON SCHEMA public TO xlooop_app;
GRANT SELECT ON board_cards TO xlooop_app;
GRANT SELECT ON project_source_bindings TO xlooop_app;
GRANT SELECT ON folder_snapshots TO xlooop_app;
GRANT EXECUTE ON FUNCTION xlooop_rls_workspace_id() TO xlooop_app;

ALTER TABLE board_cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS board_cards_workspace_policy ON board_cards;
CREATE POLICY board_cards_workspace_policy ON board_cards
  USING (workspace_id = xlooop_rls_workspace_id())
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

ALTER TABLE project_source_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_source_bindings_workspace_policy ON project_source_bindings;
CREATE POLICY project_source_bindings_workspace_policy ON project_source_bindings
  USING (workspace_id = xlooop_rls_workspace_id())
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

INSERT INTO workers_schema_version (version, description)
VALUES (47, 'board_cards + project_source_bindings RLS workspace policies + xlooop_app SELECT grants (incl folder_snapshots join grant) — 043 recipe')
ON CONFLICT (version) DO NOTHING;

-- Verify (read-only, after apply):
--   SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('board_cards','project_source_bindings');
--   SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('board_cards','project_source_bindings');
