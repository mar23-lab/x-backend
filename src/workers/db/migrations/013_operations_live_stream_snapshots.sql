-- 013_operations_live_stream_snapshots.sql · R53-W2 · MB-P push → DB live stream · 2026-05-29
--
-- W2 root cause: GET /api/v1/mbp-live-stream served a JSON file imported into
-- the Worker at BUILD time (mbp-projection.ts:40), so the operator cockpit only
-- refreshed on redeploy (multi-day staleness; source_mode fell back to
-- degraded_fallback once the 4h TTL elapsed).
--
-- Operator decision (2026-05-29): keep the GOVERNANCE-event semantics but make
-- the stream genuinely live via an MB-P → Workers push. Cloudflare Workers
-- cannot read the operator's local MB-P files, so MB-P POSTs the freshly
-- generated operations-live-stream envelope to /api/v1/mbp-live-stream/ingest;
-- this table stores the latest pushed envelope; the GET route reads the newest
-- row and falls back to the bundled import (defense in depth) when empty.
--
-- Scope (R53-W2):
--   1. CREATE TABLE operations_live_stream_snapshots (append-only; newest wins)
--   2. Bump workers_schema_version to 13
--
-- envelope JSONB = the full xlooop.operations_live_stream contract document
-- (rows[], source_mode, generated_at, valid_until, metrics, ...) verbatim, so
-- the read path returns it unchanged and the cockpit consumes the envelope's
-- own source_mode (e.g. live_mbp_read_model) instead of degraded_fallback.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 13) THEN

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'operations_live_stream_snapshots'
    ) THEN
      CREATE TABLE operations_live_stream_snapshots (
        id            BIGSERIAL PRIMARY KEY,
        stream_id     TEXT NOT NULL DEFAULT 'mbp-operations-live-stream',
        source_mode   TEXT NOT NULL DEFAULT 'live_db',
        generated_at  TIMESTAMPTZ NOT NULL,
        valid_until   TIMESTAMPTZ,
        rows_count    INTEGER NOT NULL DEFAULT 0,
        sha256        TEXT,
        envelope      JSONB NOT NULL,
        ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Newest-snapshot lookup is the only hot path: latest row per stream.
      CREATE INDEX IF NOT EXISTS idx_ols_snapshots_latest
        ON operations_live_stream_snapshots (stream_id, generated_at DESC);
    END IF;

    INSERT INTO workers_schema_version (version, applied_at, description)
    VALUES (
      13,
      now(),
      'R53-W2 · operations_live_stream_snapshots · MB-P push to DB to live read for the governance stream'
    );

  END IF;
END
$$;

COMMIT;
