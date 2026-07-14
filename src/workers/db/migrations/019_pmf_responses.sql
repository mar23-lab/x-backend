-- 019_pmf_responses.sql · PMF (Sean Ellis) survey responses · 2026-06-08
--
-- Instruments the north-star metric: "How would you feel if you could no longer use Xlooop?"
-- → the % of engaged users who answer "very disappointed" (the canonical product-market-fit /
-- must-have signal; >40% is the target). One response per user (latest wins); workspace_id is
-- the context where they answered. Optional free-text follow-ups (benefit / improvement / persona)
-- are the qualitative half of the Sean Ellis survey.
--
-- Idempotent + version-guarded (mirrors 015/018). Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/019_pmf_responses.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 19) THEN
    CREATE TABLE IF NOT EXISTS pmf_responses (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      sentiment     TEXT NOT NULL
                      CHECK (sentiment IN ('very_disappointed', 'somewhat_disappointed', 'not_disappointed')),
      benefit       TEXT,    -- "What is the main benefit you'd miss?"
      improvement   TEXT,    -- "How can we improve Xlooop for you?"
      persona       TEXT,    -- "What type of person would most benefit from Xlooop?"
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pmf_sentiment ON pmf_responses(sentiment);
    CREATE INDEX IF NOT EXISTS idx_pmf_workspace ON pmf_responses(workspace_id) WHERE workspace_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (19, 'PMF (Sean Ellis) survey responses · very-disappointed % metric', now());
  END IF;
END $$;

COMMIT;
