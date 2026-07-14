-- 059_document_access_log.sql · W4 customer-governance wave (260708) · STAGED until operator applies.
--
-- WHY (G3 — read/view actions were invisible): "who accessed document Y, when, how often" was unanswerable —
-- only writes were evented. D4 decision (operator, 260708): a DEDICATED access-telemetry table with DAY-GRAIN
-- DEDUPE — one row per (workspace, document, user, day) with a read counter — NOT evented reads (reads are
-- not causal facts; they would flood the append-only spine + the graph unboundedly) and NOT sampling (an
-- auditor's "who accessed this contract?" cannot be answered from a sample). Bounded growth
-- (users × documents × active-days); upgradeable to per-access later if a regulator demands it.
--
-- ACCESS SOURCES today: 'chat_grounding' — a document's content entering the chief-of-staff's context for a
-- user's question IS the content read (there is no per-document content GET endpoint yet; when one is born,
-- it records with its own source value — the column is TEXT for exactly that).
--
-- RLS second layer per the 043/053 house recipe (xlooop_rls_workspace_id()). Fire-and-forget writes
-- (ctx.executionCtx.waitUntil) — a read is NEVER slowed by its own audit.
-- Validate against a throwaway local Postgres before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 59) THEN

    CREATE TABLE IF NOT EXISTS document_access_log (
      id            BIGSERIAL PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      document_id   TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      access_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      access_source TEXT NOT NULL DEFAULT 'chat_grounding',
      read_count    INTEGER NOT NULL DEFAULT 1,
      first_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_read_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT document_access_log_day_key UNIQUE (workspace_id, document_id, user_id, access_date)
    );
    CREATE INDEX IF NOT EXISTS document_access_log_ws_doc_idx
      ON document_access_log (workspace_id, document_id, access_date DESC);

    -- RLS second layer (043/053 recipe): the RLS-subject client sees only its GUC workspace.
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE document_access_log ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS document_access_log_workspace_policy ON document_access_log;
      CREATE POLICY document_access_log_workspace_policy ON document_access_log
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (59, 'W4 document_access_log: day-grain deduped read audit (who accessed which document, when, how often)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT count(*) FROM information_schema.tables WHERE table_name='document_access_log';
--   SELECT conname FROM pg_constraint WHERE conname='document_access_log_day_key';
