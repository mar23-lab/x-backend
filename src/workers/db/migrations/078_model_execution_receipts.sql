-- 078_model_execution_receipts.sql · STAGED ONLY, never auto-applied.
-- Durable model-call lineage linked to the signed role resolution and customer-safe context packet.
-- Stores provider/model/status/usage/latency only: prompts, outputs and raw customer content are forbidden.
-- Runtime writes remain gated by CONTEXT_PACKET_PERSISTENCE_ENABLED; this migration activates nothing.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 78) THEN
    CREATE TABLE model_execution_receipts (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL,
      principal_id      TEXT NOT NULL,
      resolution_id     TEXT NOT NULL REFERENCES role_skill_resolutions(id) ON DELETE RESTRICT,
      context_packet_id TEXT NOT NULL REFERENCES context_packets(id) ON DELETE RESTRICT,
      action            TEXT NOT NULL CHECK (char_length(action) <= 120),
      provider          TEXT NOT NULL CHECK (provider IN ('anthropic','workers_ai')),
      model_key         TEXT NOT NULL CHECK (char_length(model_key) <= 160),
      status            TEXT NOT NULL CHECK (status IN ('started','completed','fallback','failed')),
      tokens_in         INTEGER CHECK (tokens_in IS NULL OR tokens_in >= 0),
      tokens_out        INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
      latency_ms        INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
      error_code        TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,80}$'),
      started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at      TIMESTAMPTZ
    );
    CREATE INDEX idx_model_execution_receipts_workspace
      ON model_execution_receipts(workspace_id, started_at DESC);
    CREATE INDEX idx_model_execution_receipts_incomplete
      ON model_execution_receipts(started_at) WHERE status = 'started';

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE model_execution_receipts ENABLE ROW LEVEL SECURITY;
      CREATE POLICY model_execution_receipts_workspace_policy ON model_execution_receipts
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
      GRANT SELECT, INSERT, UPDATE ON model_execution_receipts TO xlooop_app;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (78, 'default-off model execution receipts linked to role resolution and context packet; no prompt/output storage', now());
  END IF;
END $$;

COMMIT;
