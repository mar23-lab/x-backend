-- src/workers/db/migrations/017_user_source_connections_schema_realign.sql
--
-- R55-x (2026-06-06): realign user_source_connections to the schema the deployed
-- code actually uses. APPLIED to prod (Neon project flat-truth-23350426) 2026-06-06.
--
-- ROOT CAUSE
-- The PROD table was created with an OLD / divergent schema:
--   source_type (CHECK github/gitlab/bitbucket/gdrive/dropbox/onedrive/local_folder/notion),
--   provider_account_id, provider_installation_id, oauth_token_encrypted,
--   webhook_secret, metadata, scopes JSONB, status CHECK pending/connected/error/revoked.
-- But the deployed worker (008 + WorkersDalAdapter.getUserSources/createSource +
-- routes/sources.ts) expects the PROVIDER-based schema:
--   provider (CHECK github/google_drive/dropbox/gitlab/microsoft_onedrive),
--   provider_user_id, provider_username, connected_at, scopes TEXT[],
--   UNIQUE(user_id, provider).
-- 008's `CREATE TABLE IF NOT EXISTS` guard skipped re-creating the pre-existing
-- table, so the column set never converged. Result: the cockpit "Connect a source"
-- panel (and all source-connection CRUD) failed with
--   `column "provider" does not exist`.
--
-- FIX (non-destructive + idempotent)
-- If the legacy (source_type) table is present and lacks `provider`, move it AND its
-- indexes aside (index names are global, so they must be renamed too or CREATE INDEX
-- collides), preserving any rows for manual review, then create the canonical schema.
-- New indexes use CREATE INDEX IF NOT EXISTS so a partially-applied run is recoverable.
-- No DROP / DELETE / TRUNCATE.

DO $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'user_source_connections' AND column_name = 'source_type'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'user_source_connections' AND column_name = 'provider'
    ) THEN
    -- index names are schema-global; rename the legacy ones so the canonical
    -- names are free for the new table.
    ALTER INDEX IF EXISTS idx_usc_user      RENAME TO idx_usc_user_legacy_v0_260606;
    ALTER INDEX IF EXISTS idx_usc_workspace RENAME TO idx_usc_workspace_legacy_v0_260606;
    ALTER INDEX IF EXISTS idx_usc_sync_due  RENAME TO idx_usc_sync_due_legacy_v0_260606;
    ALTER TABLE user_source_connections RENAME TO user_source_connections_legacy_v0_260606;
  END IF;

  IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'user_source_connections'
    ) THEN
    CREATE TABLE user_source_connections (
      id                  TEXT PRIMARY KEY,
      workspace_id        TEXT,
      user_id             TEXT NOT NULL,
      provider            TEXT NOT NULL
                            CHECK (provider IN (
                              'github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive'
                            )),
      provider_user_id    TEXT,
      provider_username   TEXT,
      scopes              TEXT[] NOT NULL DEFAULT '{}',
      contract            JSONB NOT NULL DEFAULT '{
                            "version": 1,
                            "ingestion_mode": "reflection_only",
                            "allowed_fields": ["title","subject","timestamp","author_login"],
                            "max_body_bytes": 200,
                            "rate_limit": {"per_hour": 5000}
                          }'::jsonb,
      status              TEXT NOT NULL DEFAULT 'connected'
                            CHECK (status IN (
                              'connected', 'disconnected', 'revoked', 'error', 'pending'
                            )),
      connected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_sync_at        TIMESTAMPTZ,
      last_sync_error     TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, provider)
    );
  END IF;

  CREATE INDEX IF NOT EXISTS idx_usc_user_provider ON user_source_connections(user_id, provider);
  CREATE INDEX IF NOT EXISTS idx_usc_workspace     ON user_source_connections(workspace_id, status);
  CREATE INDEX IF NOT EXISTS idx_usc_sync_due      ON user_source_connections(status, last_sync_at)
                                                   WHERE status = 'connected';
END $$;

-- R56 Stage 0 (2026-06-07): record this migration in the version counter. The original 017 DO block
-- realigned user_source_connections but never INSERTed version 17, leaving workers_schema_version at
-- 16 then jumping to 18. Idempotent: fresh inits record it here; the one-off prod backfill runs the
-- same statement. Guarded by NOT EXISTS so it is safe regardless of the version column constraints.
INSERT INTO workers_schema_version (version, description, applied_at)
SELECT 17, 'user_source_connections schema realign (provider-based)', now()
WHERE NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 17);
