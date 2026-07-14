-- 052_user_session_preferences.sql · Wave B · canonical operating-mode persistence · 2026-07-07
--
-- WHY: the operating mode (watch/test/operator) is CLIENT-ONLY today (localStorage `xcp.cockpit.mode`,
-- src/shared/hooks/useXcpMode.js) — it does not survive across devices and the backend never NAMES a
-- canonical key. The new UI (§112.2) requires the four identity axes returned SEPARATELY
-- (Role · OperatingMode · SessionMode · Visibility, never fused). This adds the backend half: a persisted
-- operating_mode per (user, workspace), surfaced on GET /api/v1/session as an additive `identity` block and
-- mutated via an audited PATCH /api/v1/session/mode. An isolated preference table — NOT a column on a hot
-- table — so blast radius is minimal and rollback is trivial.
--
-- Additive + idempotent + version-guarded + RLS (043/045 recipe, inert-until-wired: owner bypasses).
-- Apply MANUALLY (operator-named), read-verify before + after.
--   psql "$DATABASE_URL" -f src/workers/db/migrations/052_user_session_preferences.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 52) THEN

    CREATE TABLE IF NOT EXISTS user_session_preferences (
      user_id        TEXT        NOT NULL,
      workspace_id   TEXT        NOT NULL,
      operating_mode TEXT        NOT NULL DEFAULT 'watch'
                                 CHECK (operating_mode IN ('watch', 'test', 'operator')),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, workspace_id)
    );

    -- RLS defense-in-depth (043/045 recipe): a second layer behind the app-level WHERE (user_id + workspace_id).
    -- Inert for current paths (the store routes through the owner sql, which bypasses RLS); real when a
    -- restricted xlooop_app read is ever routed through withWorkspaceRlsContext.
    GRANT USAGE ON SCHEMA public TO xlooop_app;
    GRANT SELECT ON user_session_preferences TO xlooop_app;

    ALTER TABLE user_session_preferences ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS user_session_preferences_workspace_policy ON user_session_preferences;
    CREATE POLICY user_session_preferences_workspace_policy ON user_session_preferences
      USING (workspace_id = xlooop_rls_workspace_id())
      WITH CHECK (workspace_id = xlooop_rls_workspace_id());

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (52, 'user_session_preferences (canonical operating_mode per user+workspace) — Wave B', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT relrowsecurity FROM pg_class WHERE relname='user_session_preferences';                 -- expect t
--   SELECT policyname, cmd FROM pg_policies WHERE tablename='user_session_preferences';           -- workspace_policy / ALL
--   \d user_session_preferences   -- PK (user_id, workspace_id), operating_mode CHECK
