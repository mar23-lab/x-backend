-- 022_operations_unified.sql · durable unified operations read-model (Wave 5a) · 2026-06-10
--
-- Wave 1 merges the two planes AT READ TIME: operation_events (a real table) + the governance plane,
-- which lives only as a JSONB envelope inside operations_live_stream_snapshots (parsed on every chat
-- request). That works but the governance plane is not queryable, not provenance-stamped per row, and
-- not a durable single source. This adds operations_unified — a queryable, plane-labelled table that
-- materializes the governance rows (with ingested_at provenance) so chat/board/analytics can read SQL
-- instead of parsing a blob. The `plane` column lets it hold the event-sourcing + synthetic planes
-- later without a reshape. ADDITIVE + safe: the chat reads this FIRST and falls back to the Wave-1
-- JSONB parse, so a missing/empty table never breaks the working chat.
--
-- Idempotent + version-guarded (mirrors 020/021). Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/022_operations_unified.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 22) THEN
    CREATE TABLE IF NOT EXISTS operations_unified (
      id              TEXT PRIMARY KEY,       -- stable per source row: 'gov:<row_id>' | 'evt:<event_id>'
      plane           TEXT NOT NULL
                        CHECK (plane IN ('event_sourcing', 'governance', 'synthetic')),
      source_plane_id TEXT,                   -- the source row id (live-stream row_id / operation_events.id)
      workspace_id    TEXT,
      project_id      TEXT,
      domain_id       TEXT,
      kind            TEXT,                   -- 'event' | 'packet' | 'governance_event' | 'decision' | ...
      status          TEXT,
      title           TEXT,
      summary         TEXT,
      evidence_link   TEXT,
      occurred_at     TIMESTAMPTZ,
      ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_ops_unified_plane_time ON operations_unified(plane, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ops_unified_workspace ON operations_unified(workspace_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ops_unified_project ON operations_unified(project_id) WHERE project_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (22, 'operations_unified durable read-model (plane-labelled; governance materialized)', now());
  END IF;
END $$;

COMMIT;
