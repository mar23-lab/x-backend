-- 025_prompt_tags.sql · durable per-operator prompt tags (W2) · 2026-06-10
--
-- The cockpit "Ask about X" quick-action chips (Summarize / What's blocked / Draft a digest + custom
-- ones) lived ONLY in localStorage — so they did not follow the operator across browsers or devices,
-- and there was no way to EDIT one (only add via window.prompt + remove). This makes them durable USER
-- state. GLOBAL scope (operator decision: one set across all scopes) — no workspace/project columns.
-- The id is deterministic (user_id + ':' + tag_id) so an upsert is idempotent; message is capped at the
-- route (600 chars) before it ever reaches an LLM (W4).
--
-- This ALSO satisfies the operator's "available under any login" requirement for the state that
-- actually matters (durable user prefs) — without any git-worktree cloud-persistence complexity.
--
-- Idempotent + version-guarded (mirrors 020/022/023/024). Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/025_prompt_tags.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 25) THEN
    CREATE TABLE IF NOT EXISTS prompt_tags (
      id          TEXT PRIMARY KEY,        -- deterministic: user_id || ':' || tag_id
      user_id     TEXT NOT NULL,
      tag_id      TEXT NOT NULL,
      label       TEXT NOT NULL,
      message     TEXT NOT NULL,
      sort        INTEGER NOT NULL DEFAULT 0,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, tag_id)
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_tags_user ON prompt_tags(user_id, sort, updated_at DESC);

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (25, 'prompt_tags durable per-operator quick-action chips (global scope)', now());
  END IF;
END $$;

COMMIT;
