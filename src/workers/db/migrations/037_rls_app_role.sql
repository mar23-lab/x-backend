-- 037_rls_app_role.sql · RLS defense-in-depth — the restricted, RLS-SUBJECT app role (Plane 1).
--
-- WHY (enforced-governance Plane 1, 260628): migration 034 enabled ROW LEVEL SECURITY + per-table
-- workspace policies on the operational spine (task_packets, evidence_items, approval_requests,
-- tool_events, metric_deltas), and the worker already sets the `xlooop.current_workspace_id` GUC per
-- request. BUT the worker connects to Neon as the table OWNER, and an owner BYPASSES RLS — so today the
-- RLS policies are INERT and the app-level `WHERE workspace_id = …` clauses are the SOLE tenant boundary.
-- One forgotten WHERE = a cross-tenant leak with no DB-level backstop. This migration creates a
-- NON-OWNER, NON-BYPASSRLS role (`xlooop_app`) that IS subject to RLS, so routing the worker's
-- tenant-scoped queries through it makes DB-level isolation a real SECOND layer (defense-in-depth).
--
-- BUILD-ONLY — NOT a cutover. Applying this migration creates the role + grants (inert: nothing connects
-- as it yet). The CUTOVER (operator-named flip) = (1) `ALTER ROLE xlooop_app LOGIN PASSWORD '…'` +
-- provision `XLOOOP_RLS_APP_DATABASE_URL` (wrangler secret), (2) prove zero divergence with
-- scripts/rls-shadow-soak.mjs on a Neon branch, (3) route the worker's tenant reads/writes through the
-- restricted connection. Auth + the app-level WHERE clauses stay as the first layer throughout.
--
-- Idempotent + version-guarded (safe to re-run). Apply MANUALLY per the prod-Neon one-at-a-time pattern.

DO $$
BEGIN
  -- 1. The restricted role: NOT a superuser, NOLOGIN until the operator provisions the password,
  --    and crucially NOT BYPASSRLS (the default for a fresh role) — so RLS policies APPLY to it.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
    CREATE ROLE xlooop_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    RAISE NOTICE 'created role xlooop_app (NOLOGIN; operator sets LOGIN+password at cutover)';
  ELSE
    RAISE NOTICE 'role xlooop_app already exists — leaving as-is';
  END IF;

  -- 2. Belt-and-suspenders: assert it can never bypass RLS even if altered elsewhere.
  EXECUTE 'ALTER ROLE xlooop_app NOBYPASSRLS';

  -- 3. Schema + table privileges (DML only — never DDL/owner). RLS still filters every row.
  EXECUTE 'GRANT USAGE ON SCHEMA public TO xlooop_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON '
    || 'task_packets, evidence_items, approval_requests, tool_events, metric_deltas TO xlooop_app';

  -- operation_events is READ in spine-store (assertEventInWorkspace, workspace-scoped) — SELECT only.
  -- It has NO RLS today (high-volume append-only L0 facts), so it stays app-WHERE-scoped (one layer,
  -- same as today — no regression); granting SELECT just lets the restricted role serve the spine read
  -- without a permission error. Enabling RLS on operation_events for a 2nd layer is a separate increment.
  EXECUTE 'GRANT SELECT ON operation_events TO xlooop_app';

  -- 4. The GUC-reader function the policies use (USING workspace_id = xlooop_rls_workspace_id()).
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION xlooop_rls_workspace_id() TO xlooop_app';
  END IF;

  -- 5. Sequences (if any of the spine tables use serial/identity) — USAGE+SELECT for INSERTs.
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO xlooop_app';
END $$;

-- Verify (read-only, run after apply):
--   SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname='xlooop_app';  -- expect f,f
--   SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
--     WHERE grantee='xlooop_app' ORDER BY table_name, privilege_type;
