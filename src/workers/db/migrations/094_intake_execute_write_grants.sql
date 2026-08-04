-- 094_intake_execute_write_grants.sql
--
-- WHY. `POST /api/v1/intake/:resolution_id/execute` was returning 500 in production with PostgreSQL
-- SQLSTATE 42501 (insufficient_privilege) — the core "create a task from chat" flow. Measured
-- 2026-08-04 against the live API by capturing the response, not by reading code:
--
--     POST 201  /api/v1/intake/resolve                     <- works
--     POST 500  /api/v1/intake/<id>/execute
--               {"error":"internal error","code":"42501","request_id":"a2594602ca72e6a3"}
--
-- `executeIntakeResolutionRow` (dal/intake-store.ts) writes ten tables in ONE transaction. The RLS
-- app role could not write five of them:
--
--     audit_logs        NO GRANT   RLS on, ZERO policies
--     intents           NO GRANT   RLS on, ZERO policies
--     chat_messages     NO GRANT   RLS on, 1 policy
--     chat_threads      NO GRANT   RLS on, 1 policy
--     operation_events  SELECT     RLS on, 1 policy
--
-- HOW IT HAPPENED. Migration 092 states its own premise: "ENABLE ROW LEVEL SECURITY on the 23
-- tenant-bearing tables with ZERO NON-OWNER GRANTS (fail-closed future-grant insurance; no policies,
-- no FORCE)" -- and lists audit_logs and intents among the 23. That premise held for tables nothing
-- else wrote. It did not hold for the intake-execute path, which writes them through the app role.
--
-- THE CLASS: this is the grant-parity defect INVERTED. The estate shipped GRANT-without-RLS twice
-- (graph_*, folder_snapshots) and built verify-rls-grant-parity for it. This is RLS-without-GRANT:
-- writes fail CLOSED rather than leak -- safer, still broken, and the existing gate does not look in
-- this direction. A tenant-bearing table the app role WRITES that has RLS with no policy is a
-- guaranteed runtime 42501.
--
-- WHY A BARE GRANT IS NOT ENOUGH for audit_logs and intents: RLS enabled with ZERO policies denies
-- everything regardless of grants. They need a policy AND a grant. The policy is the house idiom used
-- verbatim by chat_threads, task_packets, operation_events and intake_resolutions:
--     USING (workspace_id = xlooop_rls_workspace_id()) WITH CHECK (same)
--
-- SELECT is granted alongside INSERT on both because the DAL uses `INSERT ... RETURNING id`, which
-- requires SELECT on the returned columns. The workspace predicate scopes that read.
--
-- PROVEN ON A DISPOSABLE BRANCH COPY OF PRODUCTION before applying, as xlooop_app via SET ROLE:
--     before  audit_logs             BLOCKED 42501 permission denied
--     before  intents                BLOCKED 42501 permission denied
--     after   audit_logs             SUCCEEDED
--     after   intents                SUCCEEDED
--     after   operation_events       42501 -> 23514 (check constraint on probe values: grant works)
--   ISOLATION CONTROL -- the policies must not widen access:
--     after   intents    cross-tenant workspace_id   REFUSED (RLS policy violation)
--     after   audit_logs cross-tenant workspace_id   REFUSED (RLS policy violation)
--
-- NOTE on audit_logs: 092's own census recorded 16,799 rows of which 15,711 (93.5%) have
-- workspace_id IS NULL. The policy therefore HIDES those legacy rows from the app role, which is the
-- safe direction -- they remain fully readable to the owner connection. The intake path supplies a
-- workspace_id on every row it writes (intake-store.ts:286-291), so inserts satisfy WITH CHECK.

BEGIN;

-- Policies already exist on these three; the app role only lacked the write.
GRANT INSERT ON public.operation_events TO xlooop_app;
GRANT INSERT ON public.chat_threads     TO xlooop_app;
GRANT INSERT ON public.chat_messages    TO xlooop_app;

-- RLS on with ZERO policies = deny-all: these need a policy AND a grant.
GRANT INSERT, SELECT ON public.audit_logs TO xlooop_app;
GRANT INSERT, SELECT ON public.intents    TO xlooop_app;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'audit_logs' AND p.polname = 'audit_logs_workspace_policy'
  ) THEN
    EXECUTE 'CREATE POLICY audit_logs_workspace_policy ON public.audit_logs
             USING (workspace_id = xlooop_rls_workspace_id())
             WITH CHECK (workspace_id = xlooop_rls_workspace_id())';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'intents' AND p.polname = 'intents_workspace_policy'
  ) THEN
    EXECUTE 'CREATE POLICY intents_workspace_policy ON public.intents
             USING (workspace_id = xlooop_rls_workspace_id())
             WITH CHECK (workspace_id = xlooop_rls_workspace_id())';
  END IF;
END $$;

INSERT INTO workers_schema_version (version, description, applied_at)
VALUES (94, 'intake-execute write grants + workspace policies on audit_logs/intents (RLS-without-GRANT caused a live 42501)', now());

COMMIT;

-- READ-ONLY POSTFLIGHT (run manually; expect the app role to hold writes on all five):
--   SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type)
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'xlooop_app'
--     AND table_name IN ('audit_logs','intents','chat_messages','chat_threads','operation_events')
--   GROUP BY table_name ORDER BY table_name;
--
--   SELECT c.relname, count(p.polname) FROM pg_class c
--   LEFT JOIN pg_policy p ON p.polrelid = c.oid
--   WHERE c.relname IN ('audit_logs','intents') GROUP BY c.relname;   -- expect 1 each
