-- 020_cockpit_chat_threads.sql · cockpit chat thread persistence (Wave 3) · 2026-06-09
--
-- The cockpit chat ("Ask & Act" bar) was stateless: threads lived only in React state, so a
-- conversation vanished when the operator opened another browser (or reloaded). This persists the
-- thread server-side, keyed by (user, scope), so the chief-of-staff REMEMBERS across browsers and
-- sessions. One thread per operator per scope (workspace / project / domain); messages appended in
-- order. grounded_on stores the provenance snapshot so the rendered answer keeps its plane/counts.
--
-- Idempotent + version-guarded + additive (mirrors 018/019). Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/020_cockpit_chat_threads.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 20) THEN
    CREATE TABLE IF NOT EXISTS chat_threads (
      id            TEXT PRIMARY KEY,        -- deterministic per (user, scope_key)
      user_id       TEXT NOT NULL,
      workspace_id  TEXT,
      project_id    TEXT,
      domain_id     TEXT,
      scope_key     TEXT NOT NULL,           -- normalized workspace|project|domain key
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id            BIGSERIAL PRIMARY KEY,
      thread_id     TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      role          TEXT NOT NULL CHECK (role IN ('you', 'assistant')),
      body          TEXT NOT NULL,
      mode          TEXT,                    -- ask|plan|recommend|deep-research|chat|command|intent
      generated_by  TEXT,                    -- llm|deterministic (assistant only)
      grounded_on   JSONB,                   -- provenance snapshot (assistant only)
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_chat_threads_user_scope ON chat_threads(user_id, scope_key);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at, id);

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (20, 'cockpit chat threads + messages (cross-browser persistence)', now());
  END IF;
END $$;

COMMIT;
