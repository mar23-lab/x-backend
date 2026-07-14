-- 024_usage_events.sql · privacy-safe usage telemetry sink (W1) · 2026-06-10
--
-- The cockpit has ZERO telemetry: we cannot say which prompt chips, chat modes, or scopes the operator
-- actually uses. That blocks honest "based on usage" features (W4 AI-enhance) and all prioritization.
-- This adds an append-only usage_events sink — IDS + COUNTS ONLY, never content (no message bodies, no
-- answer text). One row per interaction; aggregates are GROUP BY ref_id. Best-effort at the call site
-- (a telemetry write must NEVER block or break the live action).
--
-- Idempotent + version-guarded (mirrors 020/022/023). Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/024_usage_events.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 24) THEN
    CREATE TABLE IF NOT EXISTS usage_events (
      id           TEXT PRIMARY KEY,        -- client-or-server generated; ON CONFLICT DO NOTHING (idempotent)
      user_id      TEXT NOT NULL,
      kind         TEXT NOT NULL,           -- 'prompt_tag' | 'chat_mode' | 'screen' | ...
      ref_id       TEXT,                    -- the tag id / mode id / screen id (NO free-text content)
      scope_key    TEXT,                    -- coarse workspace/project/domain scope label (optional)
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user_kind_time ON usage_events(user_id, kind, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_user_ref ON usage_events(user_id, kind, ref_id);

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (24, 'usage_events privacy-safe telemetry sink (ids + counts only)', now());
  END IF;
END $$;

COMMIT;
