-- 046_documents_rls.sql · RLS defense-in-depth increment — documents (customer-owned).
--
-- WHY: continues the per-table RLS cutover (034 spine, 043 operation_events, 045 projects). `documents`
-- is customer-owned (workspace_id scoped) and holds uploaded file bytes + extracted text. This enables
-- ROW LEVEL SECURITY + a workspace policy and grants `xlooop_app` SELECT, so the tenant-scoped document
-- LIST reads (metadata only) routed through that role are DB-filtered — a second layer behind the
-- app-level `WHERE workspace_id`.
--
-- SCOPE: listDocumentsRow (the enumeration surface, 2 call sites) is routed through the RLS client.
-- Document CONTENT (bytea) is write-only (never SELECTed here); getDocumentRow has no callers. xlooop_app
-- gets SELECT (reads); inserts stay on the owner path.
--
-- SAFE / INERT-UNTIL-WIRED: owner bypasses RLS. Idempotent + version-guarded. Apply MANUALLY (operator-named).

CREATE OR REPLACE FUNCTION xlooop_rls_workspace_id()
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('xlooop.current_workspace_id', true), '')
$$;

GRANT USAGE ON SCHEMA public TO xlooop_app;
GRANT SELECT ON documents TO xlooop_app;
GRANT EXECUTE ON FUNCTION xlooop_rls_workspace_id() TO xlooop_app;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_workspace_policy ON documents;
CREATE POLICY documents_workspace_policy ON documents
  USING (workspace_id = xlooop_rls_workspace_id())
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

INSERT INTO workers_schema_version (version, description)
VALUES (46, 'documents RLS workspace policy + xlooop_app SELECT grant — customer-owned second layer (043 recipe)')
ON CONFLICT (version) DO NOTHING;

-- Verify (read-only, after apply):
--   SELECT relrowsecurity FROM pg_class WHERE relname='documents';                       -- expect t
--   SELECT policyname, cmd FROM pg_policies WHERE tablename='documents';                 -- workspace_policy / ALL
