-- 088_workspace_charter.sql · STAGED ONLY, never auto-applied · Wave 1 PR-1 (the charter keystone).
-- PART-AD/AE: the CANONICAL_DOMAIN_MODEL makes the WORKSPACE own a `charter` (context-precedence
-- layer 3 — mission/background/objectives), but no charter table existed anywhere. That gap is why
-- customer info (readiness) and the plan are two disconnected islands: there was no home for the
-- company's mission/background/objectives-summary that both provisioning seeds INTO and the chat
-- grounds FROM (the info->plan join).
--
-- ONE charter per workspace (workspace_id PRIMARY KEY). Fields: mission, background, industry,
-- team_size, objectives_summary (prose roll-up; the structured Objectives live in the scoped
-- planning model, not here), constraints[] (JSONB), metadata (JSONB), audit columns.
--
-- RLS FROM BIRTH (the PART-AE memory-audit lesson). Scopes on the table's own workspace_id via the
-- mig-047 GUC helper, same single-value shape as 043/046/052/084/087. The read path is the
-- RLS-subject app connection; the SELECT grant lands in 089 (parity-safe because RLS is on here).
--
-- Verified on throwaway Neon branch before applying; APPLIED TO PROD 260721 together with 089
-- (schema v88/v89) after the PR-1b consumer routes landed.
--
-- Apply MANUALLY (operator-applied, per repo policy) — applied with 089.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 88) THEN
    CREATE TABLE IF NOT EXISTS workspace_charter (
      workspace_id       TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      mission            TEXT,
      background         TEXT,
      industry           TEXT,
      team_size          TEXT,
      objectives_summary TEXT,
      constraints        JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by         TEXT
    );

    -- RLS from birth (guard on the mig-047 GUC helper so this is safe on any head >= 47).
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE workspace_charter ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS workspace_charter_workspace_policy ON workspace_charter;
      CREATE POLICY workspace_charter_workspace_policy ON workspace_charter
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (88, 'W1-PR1 charter keystone: workspace_charter (one charter per workspace — mission/background/industry/team_size/objectives_summary/constraints) with RLS-from-birth per the PART-AE lesson. Additive.', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT count(*) FROM information_schema.columns WHERE table_name='workspace_charter';  -- 11
--   SELECT relrowsecurity FROM pg_class WHERE relname='workspace_charter';                 -- t
--   SELECT policyname FROM pg_policies WHERE tablename='workspace_charter';
