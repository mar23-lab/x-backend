-- 039_gmail_source.sql · Wave C · S5b (260628) · admit 'gmail' as an OAuth source provider.
--
-- The first picker-provider ingestion translator (src/workers/sources/translators/gmail.ts) emits
-- operation_events with source_tool='gmail' and binds via user_source_connections.provider='gmail'.
-- Both columns carry a CHECK constraint; Postgres has no ALTER CHECK, so each is dropped + re-added
-- (preserving EVERY prior value — mirrors 008's + 026's drop+re-add). Idempotent, guarded by
-- workers_schema_version so a re-run is a no-op.
--
-- OPERATOR-APPLIED (the Neon DB change is operator-gated). Until this runs, a user cannot even create
-- a gmail connection (the provider CHECK rejects it), so the translator is fully dormant — no event can
-- carry source_tool='gmail' before the constraint admits it.
--
-- Run:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/039_gmail_source.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 39) THEN
    -- (1) admit 'gmail' as a source_tool on operation_events (preserve every value 001+008+026 set).
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operation_events_source_tool_check') THEN
      ALTER TABLE operation_events DROP CONSTRAINT operation_events_source_tool_check;
    END IF;
    ALTER TABLE operation_events
      ADD CONSTRAINT operation_events_source_tool_check
      CHECK (source_tool IN (
        'codex', 'claude', 'harness', 'mbp', 'xlooop', 'operator',
        'github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive',
        'folder', 'gmail'
      ));

    -- (2) admit 'gmail' as a user_source_connections.provider (preserve the 008 free-tier set).
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_source_connections_provider_check') THEN
      ALTER TABLE user_source_connections DROP CONSTRAINT user_source_connections_provider_check;
    END IF;
    ALTER TABLE user_source_connections
      ADD CONSTRAINT user_source_connections_provider_check
      CHECK (provider IN (
        'github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive', 'gmail'
      ));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (39, 'Wave C S5b · admit gmail as an OAuth source provider (source_tool + provider CHECKs)', now());
  END IF;
END $$;
