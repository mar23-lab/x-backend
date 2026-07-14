-- 040_outlook_source.sql · Wave C · S5b (260628) · admit 'outlook' as an OAuth source provider.
--
-- The second picker-provider ingestion translator (src/workers/sources/translators/outlook.ts) emits
-- operation_events with source_tool='outlook' and binds via user_source_connections.provider='outlook'.
-- Both columns carry a CHECK constraint; Postgres has no ALTER CHECK, so each is dropped + re-added
-- (preserving EVERY prior value, including 039's 'gmail'). Idempotent, guarded by workers_schema_version.
--
-- OPERATOR-APPLIED (the Neon DB change is operator-gated). Apply AFTER 039. Until this runs, an outlook
-- connection cannot be created (the provider CHECK rejects it), so the translator is fully dormant.
--
-- Run:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/040_outlook_source.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 40) THEN
    -- (1) admit 'outlook' as a source_tool on operation_events (preserve every value 001+008+026+039 set).
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operation_events_source_tool_check') THEN
      ALTER TABLE operation_events DROP CONSTRAINT operation_events_source_tool_check;
    END IF;
    ALTER TABLE operation_events
      ADD CONSTRAINT operation_events_source_tool_check
      CHECK (source_tool IN (
        'codex', 'claude', 'harness', 'mbp', 'xlooop', 'operator',
        'github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive',
        'folder', 'gmail', 'outlook'
      ));

    -- (2) admit 'outlook' as a user_source_connections.provider (preserve the 008 + 039 set).
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_source_connections_provider_check') THEN
      ALTER TABLE user_source_connections DROP CONSTRAINT user_source_connections_provider_check;
    END IF;
    ALTER TABLE user_source_connections
      ADD CONSTRAINT user_source_connections_provider_check
      CHECK (provider IN (
        'github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive', 'gmail', 'outlook'
      ));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (40, 'Wave C S5b · admit outlook as an OAuth source provider (source_tool + provider CHECKs)', now());
  END IF;
END $$;
