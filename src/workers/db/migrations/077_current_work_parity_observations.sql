-- 077_current_work_parity_observations.sql · STAGED ONLY, never auto-applied.
-- Persists customer-safe dual-read observations for Current Work v2. It stores only versions,
-- counts, hashes and allowlisted difference codes: no work ids, titles, prompts or evidence content.
-- The write route remains default-OFF and this migration does not switch Current Work authority.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 77) THEN
    CREATE TABLE current_work_parity_observations (
      id                          TEXT PRIMARY KEY,
      workspace_id                TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_user_id               TEXT NOT NULL,
      server_projection_version   INTEGER NOT NULL CHECK (server_projection_version >= 1),
      client_projection_version   INTEGER NOT NULL CHECK (client_projection_version >= 1),
      server_current_work_version TEXT NOT NULL CHECK (char_length(server_current_work_version) <= 160),
      client_current_work_version TEXT NOT NULL CHECK (char_length(client_current_work_version) <= 160),
      parity_status               TEXT NOT NULL CHECK (parity_status IN ('match','mismatch','client_unavailable','server_unavailable')),
      difference_codes            TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(difference_codes) <= 20),
      server_state_sha256         TEXT CHECK (server_state_sha256 IS NULL OR server_state_sha256 ~ '^[a-f0-9]{64}$'),
      client_state_sha256         TEXT CHECK (client_state_sha256 IS NULL OR client_state_sha256 ~ '^[a-f0-9]{64}$'),
      server_item_count           INTEGER CHECK (server_item_count IS NULL OR server_item_count >= 0),
      client_item_count           INTEGER CHECK (client_item_count IS NULL OR client_item_count >= 0),
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_current_work_parity_workspace
      ON current_work_parity_observations(workspace_id, created_at DESC);
    CREATE INDEX idx_current_work_parity_mismatch
      ON current_work_parity_observations(parity_status, created_at DESC)
      WHERE parity_status <> 'match';

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE current_work_parity_observations ENABLE ROW LEVEL SECURITY;
      CREATE POLICY current_work_parity_observations_workspace_policy ON current_work_parity_observations
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
      GRANT SELECT, INSERT ON current_work_parity_observations TO xlooop_app;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (77, 'default-off customer-safe Current Work dual-read parity observations; no authority switch', now());
  END IF;
END $$;

COMMIT;
