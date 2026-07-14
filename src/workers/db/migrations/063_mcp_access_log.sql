-- 063_mcp_access_log.sql · L2 (260710-D) · STAGED until operator applies.
--
-- WHY (G2 — MCP tenant READS were invisible): the T4/P7 customer read tools (list_sources, get_evidence,
-- list_receipts, documents-metadata) answer an MCP agent with tenant data but leave NO trace — "which
-- agent read what, when, how often" was unanswerable. This re-instantiates the 059/D4 parent pattern at
-- TOOL grain: a DEDICATED access-telemetry table with DAY-GRAIN DEDUPE — one row per
-- (workspace, tool, actor, day) with a read counter — NOT evented reads (reads are not causal facts;
-- they would flood the append-only spine) and NOT sampling. Bounded growth (actors × tools × active-days).
--
-- actor_id = the verified auth principal (user id or customer-token principal); instrument_kind uses the
-- 050 actor-lineage vocabulary (MCP surface ⇒ 'agent' by default; the column exists so a future non-agent
-- instrument records honestly). Writes are fire-and-forget (waitUntil) — a read is NEVER slowed by audit.
-- Consumer flag: MCP_READ_AUDIT_ENABLED (default off). RLS second layer per the 043/053 house recipe.
-- Validate against a throwaway local Postgres before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 63) THEN

    CREATE TABLE IF NOT EXISTS mcp_access_log (
      id              BIGSERIAL PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      tool            TEXT NOT NULL,
      actor_id        TEXT NOT NULL,
      instrument_kind TEXT NOT NULL DEFAULT 'agent',
      access_date     DATE NOT NULL DEFAULT CURRENT_DATE,
      read_count      INTEGER NOT NULL DEFAULT 1,
      first_read_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT mcp_access_log_day_key UNIQUE (workspace_id, tool, actor_id, access_date)
    );
    CREATE INDEX IF NOT EXISTS mcp_access_log_ws_idx
      ON mcp_access_log (workspace_id, access_date DESC);

    -- RLS second layer (043/053 recipe): the RLS-subject client sees only its GUC workspace.
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE mcp_access_log ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS mcp_access_log_workspace_policy ON mcp_access_log;
      CREATE POLICY mcp_access_log_workspace_policy ON mcp_access_log
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (63, 'L2 mcp_access_log: day-grain deduped MCP tenant-read audit (which agent read what, when, how often)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT count(*) FROM information_schema.tables WHERE table_name='mcp_access_log';
--   SELECT conname FROM pg_constraint WHERE conname='mcp_access_log_day_key';
