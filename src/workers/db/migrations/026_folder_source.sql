-- 026_folder_source.sql · reflection-only folder connector (W3) · 2026-06-10
--
-- A "folder source" lets a non-git folder behave like a source: the operator's client posts a snapshot
-- (files + checksums), the server diffs it against the stored baseline and emits one reflection_only
-- event per add/modify/delete — flowing through the SAME operation_events -> operations_unified ->
-- intents/lineage spine the cockpit already reads (NO new data plane). This is the ORIGINAL honest
-- intent: "folders -> packets for people who don't use git". The folder NEVER writes back; it only
-- observes (the connector's whole safety property).
--
-- Two changes: (1) extend operation_events.source_tool CHECK to admit 'folder' (mirrors 008's
-- drop+re-add — Postgres has no ALTER CHECK); (2) folder_snapshots — the durable per-binding baseline
-- the next sync diffs against. The project_source_bindings.source_kind 'desktop_folder' already exists
-- (migration 016), so the binding side needs no change.
--
-- Idempotent + version-guarded (mirrors 008/020/024/025). Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/026_folder_source.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 26) THEN
    -- (1) admit 'folder' as a source_tool (preserve every value 001 + 008 set).
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operation_events_source_tool_check') THEN
      ALTER TABLE operation_events DROP CONSTRAINT operation_events_source_tool_check;
    END IF;
    ALTER TABLE operation_events
      ADD CONSTRAINT operation_events_source_tool_check
      CHECK (source_tool IN (
        'codex', 'claude', 'harness', 'mbp', 'xlooop', 'operator',
        'github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive',
        'folder'
      ));

    -- (2) the durable per-binding folder baseline (files + checksums). One row per folder binding.
    CREATE TABLE IF NOT EXISTS folder_snapshots (
      binding_id   TEXT PRIMARY KEY,        -- the project_source_bindings.binding_id (1 folder = 1 binding)
      workspace_id TEXT,
      project_id   TEXT,
      path         TEXT,                     -- the registered folder path (a label; the server never reads FS)
      files        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{path, checksum, size?}]
      synced_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_folder_snapshots_workspace ON folder_snapshots(workspace_id);

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (26, 'reflection-only folder connector — source_tool +folder + folder_snapshots baseline', now());
  END IF;
END $$;

COMMIT;
