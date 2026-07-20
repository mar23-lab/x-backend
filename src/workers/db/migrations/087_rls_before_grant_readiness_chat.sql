-- 087_rls_before_grant_readiness_chat.sql · APPLIED TO PROD 260720 via Neon MCP (session 260720).
-- PART-AE memory-architecture audit finding #1: readiness_assessments (the semantic memory injected
-- into EVERY customer + operator LLM turn via companyContextPreamble), chat_threads/chat_messages
-- (conversational memory), and customer_authority_consents were the only tenant-keyed customer-memory
-- tables with NO ROW LEVEL SECURITY (018/020 predate the RLS cutover; 043/046/052/071/036/083 peers
-- all have policies).
--
-- HONEST SEVERITY (measured in prod before writing this): NONE of these four tables has any
-- xlooop_app grant — every read runs on the OWNER connection (which bypasses RLS), so there is NO
-- live cross-tenant hole today, and verify-rls-grant-parity passes vacuously (grant-subset-of-RLS
-- holds because there is no grant). The risk is LATENT: the first future GRANT to xlooop_app without
-- a policy is the silent cross-tenant read class (AGENTS.md grant-parity invariant). This migration
-- applies the 084 doctrine — policy BEFORE grant — so these tables are safe-by-default the day the
-- RLS cutover expands to them. INERT in prod by construction (owner bypasses RLS).
--
-- SCOPING: readiness_assessments.workspace_id is NULLABLE (anonymous funnel leads pre-workspace);
-- under the policy those NULL rows are invisible on the app connection — correct (anonymous leads
-- must never be app-connection-readable). chat_threads scopes on its own workspace_id (also nullable,
-- same reasoning); chat_messages carries no workspace_id and scopes through its parent thread
-- (EXISTS join). customer_authority_consents.workspace_id is NOT NULL — direct policy.
--
-- Verified on throwaway Neon branch mig087-rls-verify-260720 before the prod apply: 4/4 relrowsecurity,
-- 4 policies, owner reads unaffected (13 readiness rows / 86 chat messages readable), version 87.
-- Prod apply reproduced identically.
--
-- Apply MANUALLY (operator-applied, per repo policy) — ALREADY APPLIED to prod 260720:
--   -- via Neon MCP on project flat-truth-23350426 after review (the sanctioned path used here).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 87) THEN
    -- Guard on the GUC helper (created in 047) so this is safe to run on any head >= 47.
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE readiness_assessments ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS readiness_assessments_workspace_policy ON readiness_assessments;
      CREATE POLICY readiness_assessments_workspace_policy ON readiness_assessments
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());

      ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS chat_threads_workspace_policy ON chat_threads;
      CREATE POLICY chat_threads_workspace_policy ON chat_threads
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());

      ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS chat_messages_thread_workspace_policy ON chat_messages;
      CREATE POLICY chat_messages_thread_workspace_policy ON chat_messages
        USING (EXISTS (SELECT 1 FROM chat_threads t
                       WHERE t.id = chat_messages.thread_id
                         AND t.workspace_id = xlooop_rls_workspace_id()))
        WITH CHECK (EXISTS (SELECT 1 FROM chat_threads t
                            WHERE t.id = chat_messages.thread_id
                              AND t.workspace_id = xlooop_rls_workspace_id()));

      ALTER TABLE customer_authority_consents ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS customer_authority_consents_workspace_policy ON customer_authority_consents;
      CREATE POLICY customer_authority_consents_workspace_policy ON customer_authority_consents
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (87, 'RLS-before-grant forward-safety: enable RLS + workspace policies on readiness_assessments, chat_threads, chat_messages (via parent thread), customer_authority_consents. These tables have NO xlooop_app grant today (owner-connection reads only) so this is INERT in prod; it guarantees any FUTURE app-role grant is policy-backed from birth (the 084 grant-parity doctrine).', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT relname, relrowsecurity FROM pg_class
--     WHERE relname IN ('readiness_assessments','chat_threads','chat_messages','customer_authority_consents');
--   SELECT tablename, policyname FROM pg_policies
--     WHERE tablename IN ('readiness_assessments','chat_threads','chat_messages','customer_authority_consents');
