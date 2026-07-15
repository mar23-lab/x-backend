-- 075_single_intake_and_execution_receipts.sql · canonical tenant intake — STAGED ONLY.
-- Additive persistence for resolve -> preview -> execute. This migration does not enable
-- SINGLE_INTAKE_ENABLED and must not be applied to production without Marat's explicit approval.
-- Raw request text is represented by a digest; only the interpreted execution payload is durable.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 75) THEN
    CREATE TABLE intake_resolutions (
      id                    TEXT PRIMARY KEY,
      workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_user_id         TEXT NOT NULL,
      project_id            TEXT,
      client_request_id     TEXT NOT NULL,
      request_digest        TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
      operation             TEXT NOT NULL CHECK (operation IN ('answer','plan','create_work','continue_work','decide','inspect','unresolved')),
      confidence            DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      ambiguity             BOOLEAN NOT NULL DEFAULT false,
      target                JSONB NOT NULL,
      effect_summary        TEXT NOT NULL CHECK (char_length(effect_summary) <= 1000),
      risk                  TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
      authority             JSONB NOT NULL,
      context_summary       JSONB NOT NULL,
      required_tools        TEXT[] NOT NULL DEFAULT '{}',
      requires_confirmation BOOLEAN NOT NULL,
      next_step             TEXT NOT NULL CHECK (next_step IN ('answer_now','draft_plan','confirm','clarify','blocked')),
      action_payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
      current_work_version  INTEGER NOT NULL DEFAULT 0 CHECK (current_work_version >= 0),
      version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','expired','cancelled')),
      expires_at            TIMESTAMPTZ NOT NULL,
      consumed_at           TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, actor_user_id, client_request_id)
    );

    CREATE TABLE governed_execution_receipts (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      resolution_id  TEXT NOT NULL UNIQUE REFERENCES intake_resolutions(id) ON DELETE RESTRICT,
      actor_user_id  TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      operation      TEXT NOT NULL,
      target_type    TEXT NOT NULL,
      target_id      TEXT,
      result         TEXT NOT NULL CHECK (result = 'completed'),
      effect_summary TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, actor_user_id, client_request_id)
    );

    CREATE TABLE projection_outbox (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      event_type     TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id   TEXT NOT NULL,
      payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at    TIMESTAMPTZ,
      attempt_count   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_intake_resolutions_workspace ON intake_resolutions(workspace_id, created_at DESC);
    CREATE INDEX idx_execution_receipts_workspace ON governed_execution_receipts(workspace_id, created_at DESC);
    CREATE INDEX idx_projection_outbox_pending ON projection_outbox(created_at) WHERE processed_at IS NULL;

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE intake_resolutions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE governed_execution_receipts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE projection_outbox ENABLE ROW LEVEL SECURITY;
      CREATE POLICY intake_resolutions_workspace_policy ON intake_resolutions
        USING (workspace_id = xlooop_rls_workspace_id()) WITH CHECK (workspace_id = xlooop_rls_workspace_id());
      CREATE POLICY governed_execution_receipts_workspace_policy ON governed_execution_receipts
        USING (workspace_id = xlooop_rls_workspace_id()) WITH CHECK (workspace_id = xlooop_rls_workspace_id());
      CREATE POLICY projection_outbox_workspace_policy ON projection_outbox
        USING (workspace_id = xlooop_rls_workspace_id()) WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
      GRANT SELECT, INSERT, UPDATE ON intake_resolutions, governed_execution_receipts, projection_outbox TO xlooop_app;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (75, 'default-off single intake resolutions, atomic governed execution receipts, projection outbox; no production activation', now());
  END IF;
END $$;

COMMIT;
