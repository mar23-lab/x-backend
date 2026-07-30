-- 092_tenant_bearing_rls_enable.sql · ADR-0110 step 1 — close the future-grant hazard on the
-- 23 tenant-bearing tables that carry workspace_id but have no RLS.
--
-- WHY. Measured live on 2026-07-31: 96 tables, 50 RLS-enabled, 0 FORCE, and 23 tables carrying a
-- workspace_id column with RLS DISABLED. The instinct is to read that as an open cross-tenant read.
-- It is not — the same measurement shows those 23 hold **zero non-owner grants**, so no login role
-- can reach them today. The real hazard is prospective and it has already happened once in this
-- estate: `xlooop_graph_ro` was GRANTed SELECT on graph_nodes/graph_edges/graph_snapshots while RLS
-- was off, which made 8 tenants' rows readable by one role (revoked 2026-07-28). A single future
-- GRANT on any of these 23 reopens exactly that shape, silently, with every static gate green.
--
-- Enabling RLS with no policy makes the failure mode fail-CLOSED instead: a future grantee reads
-- zero rows and notices immediately, rather than reading everything and nobody noticing.
--
-- WHY NO POLICIES HERE — and this is a measurement, not a preference. A blanket
-- `workspace_id = xlooop_rls_workspace_id()` policy is wrong for at least three of these tables:
--
--     audit_logs                16,799 rows · 15,711 workspace_id IS NULL  (93.5%)
--     user_source_connections        3 rows ·      3 NULL                 (100%)
--     investor_entitlements          2 rows ·      2 NULL                 (100%)
--
-- Strict equality would hide 93.5% of audit history and 100% of two other tables from a granted
-- role; 080 needed an explicit `OR workspace_id IS NULL` escape for precisely this reason, and
-- whether each of these 23 wants that escape is a per-table semantic decision. Guessing it across
-- 23 tables in one migration would encode 23 unverified assumptions. Policies land per table in
-- ADR-0110 step 3, alongside the DAL module that actually routes through the RLS connection.
--
-- SAFE / INERT: the worker connects as table OWNER on 69 of 75 DAL modules, and owners bypass RLS
-- unless FORCE is set. FORCE is deliberately NOT set here — forcing before step 3 would break those
-- 69 modules in production. Net runtime effect of this migration today: none. That is the point.
--
-- FAIL-CLOSED PRECONDITION. This migration asserts its own premise instead of trusting the
-- measurement that motivated it. If any of the 23 has acquired a non-owner or PUBLIC grant between
-- authoring and apply, enabling RLS without a policy would instantly zero that grantee's reads — so
-- the migration RAISEs and changes nothing. A migration whose safety argument rests on a fact it
-- does not check is the false-green class this estate keeps paying for.
--
-- Idempotent (ENABLE on an already-enabled table is a no-op) and safe to re-run. Apply MANUALLY per
-- the prod-Neon one-at-a-time pattern; read-verify before and after. Authority: ADR-0110 Decision B
-- step 1; 080 shape; 037 role model.

DO $$
DECLARE
  targets TEXT[] := ARRAY[
    'audit_logs',
    'customer_api_tokens',
    'customer_entitlements',
    'decisions',
    'graph_edges',
    'graph_nodes',
    'graph_snapshots',
    'intents',
    'investor_entitlements',
    'operations_unified',
    'operator_sessions',
    'pmf_responses',
    'sign_offs',
    'source_repos',
    'synthetic_domain_goal_relationships',
    'synthetic_domain_goals',
    'synthetic_domain_membership',
    'synthetic_domain_propagation_rules',
    'synthetic_domain_recommendations',
    'synthetic_domain_roadmaps',
    'user_source_connections',
    'user_source_connections_legacy_v0_260606',
    'workspace_members'
  ];
  missing   TEXT;
  offending TEXT;
  enabled   INT := 0;
  t         TEXT;
BEGIN
  -- Precondition A: every named table still exists as an ordinary table. A silently-renamed or
  -- dropped table must not be skipped quietly — that would leave a tenant-bearing table unprotected
  -- while this migration reported success.
  SELECT string_agg(x, ', ' ORDER BY x) INTO missing
  FROM unnest(targets) AS x
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relname = x AND c.relkind = 'r'
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing 092: named tenant-bearing table(s) absent from public schema: %. '
      'Re-measure the target set before applying.', missing;
  END IF;

  -- Precondition B: still zero non-owner and zero PUBLIC grants. Read from pg_class.relacl rather
  -- than information_schema.role_table_grants, which filters by the querying role's membership and
  -- can therefore under-report — an under-report here would read as "safe to proceed".
  SELECT string_agg(DISTINCT c.relname || ' -> ' ||
                    CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                         ELSE a.grantee::regrole::text END, ', ')
    INTO offending
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  CROSS JOIN LATERAL aclexplode(c.relacl) AS a
  WHERE c.relname = ANY (targets)
    AND (
      a.grantee = 0
      OR (
        a.grantee <> c.relowner
        AND a.grantee::regrole::text NOT IN ('postgres', 'neondb_owner', 'cloud_admin')
      )
    );
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing 092: grant(s) exist on target table(s) — enabling RLS without a policy would zero '
      'their reads: %. Write the per-table policy first (ADR-0110 step 3), then re-run.', offending;
  END IF;

  FOREACH t IN ARRAY targets LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    enabled := enabled + 1;
  END LOOP;

  RAISE NOTICE '092: row level security enabled on % tenant-bearing table(s); 0 policies by design '
               '(ADR-0110 step 3 owns policies); FORCE deliberately unset', enabled;
END $$;

INSERT INTO workers_schema_version (version, description)
VALUES (92, 'ADR-0110 step 1 — ENABLE ROW LEVEL SECURITY on the 23 tenant-bearing tables with zero non-owner grants (fail-closed future-grant insurance; no policies, no FORCE)')
ON CONFLICT (version) DO NOTHING;

-- Verify (read-only, run after apply):
--   -- expect 0: no tenant-bearing table left without RLS
--   SELECT count(*) FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
--     JOIN information_schema.columns col
--       ON col.table_schema = 'public' AND col.table_name = c.relname
--      AND col.column_name = 'workspace_id'
--    WHERE c.relkind = 'r' AND NOT c.relrowsecurity;
--
--   -- expect 73 (50 pre-existing + 23 from this migration), and FORCE still 0
--   SELECT count(*) FILTER (WHERE relrowsecurity) AS rls,
--          count(*) FILTER (WHERE relforcerowsecurity) AS forced
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
--    WHERE c.relkind = 'r';
--
--   -- expect 92
--   SELECT max(version) FROM workers_schema_version;
