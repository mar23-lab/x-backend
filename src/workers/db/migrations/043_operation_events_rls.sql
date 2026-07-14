-- 043_operation_events_rls.sql · RLS defense-in-depth increment — the customer-visible spine.
--
-- WHY (continues Plane 1, 260628 → 260706): migration 034 put ROW LEVEL SECURITY on the operational
-- spine (task_packets, evidence_items, approval_requests, tool_events, metric_deltas) and 037 created
-- the non-owner, NOBYPASSRLS role `xlooop_app`. 037 DELIBERATELY left `operation_events` without RLS
-- ("high-volume append-only L0 facts … a separate increment") and granted `xlooop_app` SELECT-only on it.
-- This IS that separate increment: it enables RLS + a workspace policy on operation_events so that
-- tenant-scoped READS routed through the restricted role get a real DB-level second layer, completing
-- the protection started by 042 (the append-only UPDATE trigger, which guards writes).
--
-- SAFE / INERT-UNTIL-WIRED: the worker connects to Neon as the table OWNER, and the owner BYPASSES RLS.
-- So enabling RLS here changes NOTHING for the current owner-connected read/write paths — existing
-- event ingestion and every current query keep working unchanged. The policy only bites once a store
-- routes its operation_events reads through `xlooop_app` (XLOOOP_RLS_APP_DATABASE_URL) inside a
-- `set_config('xlooop.current_workspace_id', …, true)` transaction — the SAME pattern the spine uses
-- (withWorkspaceRlsContext in operational-spine-store.ts). Until that store change lands + is soaked,
-- this migration is a dormant backstop.
--
-- GRANTS: 037 already granted `xlooop_app` SELECT on operation_events (reads only — event INSERTs stay
-- on the owner append path, guarded by the 042 append-only trigger). No new grant is needed here; the
-- policy shape is USING-only for SELECT plus a WITH CHECK that fails closed if a non-owner ever attempts
-- a write with a mismatched workspace.
--
-- Idempotent + version-guarded (safe to re-run). Apply MANUALLY per the prod-Neon one-at-a-time pattern.
-- Authority: enforced-governance Plane 1; 037 "separate increment" note; 042 append-only floor.

-- The GUC-reader the policies use already exists (created in 034). Recreate defensively so this
-- migration is self-contained if applied against a DB where 034's function was ever dropped.
CREATE OR REPLACE FUNCTION xlooop_rls_workspace_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('xlooop.current_workspace_id', true), '')
$$;

ALTER TABLE operation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operation_events_workspace_policy ON operation_events;
CREATE POLICY operation_events_workspace_policy ON operation_events
  USING (workspace_id = xlooop_rls_workspace_id())
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

INSERT INTO workers_schema_version (version, description)
VALUES (43, 'operation_events RLS workspace policy — customer-spine second layer (037 separate increment; 042 companion)')
ON CONFLICT (version) DO NOTHING;

-- Verify (read-only, run after apply):
--   SELECT relrowsecurity FROM pg_class WHERE relname='operation_events';                 -- expect t
--   SELECT policyname, cmd FROM pg_policies WHERE tablename='operation_events';           -- workspace_policy / ALL
--   -- owner still sees all (bypass); xlooop_app with GUC=A sees only A's rows, none of B's (shadow-soak).
