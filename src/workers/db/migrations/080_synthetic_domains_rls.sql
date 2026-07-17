-- 080_synthetic_domains_rls.sql · RLS defense-in-depth increment — the lens/domain surface.
--
-- WHY (continues Plane 1; completes the 034 → 037 → 043 series for this table): `synthetic_domains`
-- carries operator-personal content (the 011 personal-life seed: Health/Finance/Family/Work/Learning/
-- Creative rows in workspace `mbp-private`, visibility `operator_only`) yet had NO DB-level RLS —
-- across all 8 migrations touching the table there is no ENABLE ROW LEVEL SECURITY and no policy.
-- Workspace isolation for lens/domain rows relied entirely on app-layer WHERE clauses, which means
-- one route bug away from cross-workspace exposure of personal data. Surfaced by the 2026-07-17
-- architecture audit (screenshot evidence: raw seed slug `sd_seed_mbp_creative` rendered in the
-- operator's own workspace — correctly scoped, but proving the rows are live in prod).
--
-- SAFE / INERT-UNTIL-WIRED: identical posture to 043 — the worker connects as table OWNER, which
-- bypasses RLS, so nothing changes for current paths. The policy bites only when reads route through
-- the non-owner `xlooop_app` role (XLOOOP_RLS_APP_DATABASE_URL) inside a
-- set_config('xlooop.current_workspace_id', …, true) transaction — the same withWorkspaceRlsContext
-- pattern the operational spine uses. Until that store change lands + soaks, this is a dormant backstop.
--
-- NULL-workspace nuance: cross-workspace lens domains legitimately carry workspace_id NULL and are
-- shared-by-design (rendered as the AUTO LENSES rail; see x-ai-front live-data.js "Cross-workspace
-- lens domains (workspace_id NULL)"). The USING clause therefore permits NULL-workspace rows for any
-- tenant context; WITH CHECK stays strict equality so a non-owner can never WRITE a NULL-workspace or
-- cross-workspace row — writes fail closed.
--
-- GRANTS: 037 granted xlooop_app on the spine tables + SELECT on operation_events only. This table
-- needs its own SELECT grant for the backstop to be meaningful at cutover; guarded so the migration
-- stays self-contained when the role does not exist yet.
--
-- Idempotent + version-guarded (safe to re-run). Apply MANUALLY per the prod-Neon one-at-a-time
-- pattern; read-verify before + after. Authority: enforced-governance Plane 1; 037 role; 043 shape.

CREATE OR REPLACE FUNCTION xlooop_rls_workspace_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('xlooop.current_workspace_id', true), '')
$$;

ALTER TABLE synthetic_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS synthetic_domains_workspace_policy ON synthetic_domains;
CREATE POLICY synthetic_domains_workspace_policy ON synthetic_domains
  USING (workspace_id = xlooop_rls_workspace_id() OR workspace_id IS NULL)
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
    EXECUTE 'GRANT SELECT ON synthetic_domains TO xlooop_app';
    RAISE NOTICE 'granted SELECT on synthetic_domains to xlooop_app';
  ELSE
    RAISE NOTICE 'role xlooop_app absent — grant deferred to 037 application';
  END IF;
END $$;

INSERT INTO workers_schema_version (version, description)
VALUES (80, 'synthetic_domains RLS workspace policy — lens/domain second layer (personal-seed exposure hardening; 043 companion)')
ON CONFLICT (version) DO NOTHING;

-- Verify (read-only, run after apply):
--   SELECT relrowsecurity FROM pg_class WHERE relname='synthetic_domains';                -- expect t
--   SELECT policyname, cmd FROM pg_policies WHERE tablename='synthetic_domains';          -- workspace_policy / ALL
--   -- Under xlooop_app with xlooop.current_workspace_id='<any customer ws>':
--   SELECT count(*) FROM synthetic_domains WHERE workspace_id='mbp-private';              -- expect 0
