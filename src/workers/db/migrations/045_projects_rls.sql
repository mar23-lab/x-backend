-- 045_projects_rls.sql · RLS defense-in-depth increment — projects (customer-owned).
--
-- WHY: continues the per-table RLS cutover (034 spine, 043 operation_events). `projects` is a core
-- customer-owned table (workspace_id scoped). This enables ROW LEVEL SECURITY + a workspace policy and
-- grants the restricted `xlooop_app` role SELECT, so tenant-scoped project READS routed through that
-- role are filtered at the DB — a real second layer behind the app-level `WHERE workspace_id`.
--
-- SCOPE (this increment): the project LIST reads (listProjects, listChildProjects) are routed through
-- rlsSql in the app — they are the cross-tenant ENUMERATION surface. The single-project getProjectRow
-- has 6 internal callers and stays on the owner path for now (still app-WHERE scoped, one layer, no
-- regression); routing it is a deliberate follow-up. xlooop_app gets SELECT only (reads); project
-- writes stay on the owner append path.
--
-- SAFE / INERT-UNTIL-WIRED: owner bypasses RLS, so enabling it changes nothing for current paths.
-- Idempotent + version-guarded. Apply MANUALLY per the prod-Neon one-at-a-time pattern (operator-named).

CREATE OR REPLACE FUNCTION xlooop_rls_workspace_id()
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('xlooop.current_workspace_id', true), '')
$$;

GRANT USAGE ON SCHEMA public TO xlooop_app;
GRANT SELECT ON projects TO xlooop_app;
GRANT EXECUTE ON FUNCTION xlooop_rls_workspace_id() TO xlooop_app;

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_workspace_policy ON projects;
CREATE POLICY projects_workspace_policy ON projects
  USING (workspace_id = xlooop_rls_workspace_id())
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

INSERT INTO workers_schema_version (version, description)
VALUES (45, 'projects RLS workspace policy + xlooop_app SELECT grant — customer-owned second layer (043 recipe)')
ON CONFLICT (version) DO NOTHING;

-- Verify (read-only, after apply):
--   SELECT relrowsecurity FROM pg_class WHERE relname='projects';                        -- expect t
--   SELECT policyname, cmd FROM pg_policies WHERE tablename='projects';                  -- workspace_policy / ALL
--   SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='xlooop_app' AND table_name='projects';
