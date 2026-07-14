-- 064_llm_usage_log.sql · G2 (260711) · STAGED until operator applies.
--
-- WHY (per-tenant LLM metering — the commercial-staircase prerequisite): before this table, a customer
-- could drive unbounded LLM spend invisibly — the Claude Messages API's usage object was parsed away in
-- cockpit-chat.ts and Workers-AI usage was never read. This re-instantiates the 059/D4 parent pattern at
-- USAGE grain: a DEDICATED accumulator table with DAY-GRAIN DEDUPE — one row per
-- (workspace, model, user, day) with call + token counters — NOT per-call rows (derived observations are
-- not causal facts; they would flood) and NOT the 024 usage_events table (an append-only UI-telemetry
-- id-sink with a different consumer contract; retrofitting accumulators would mutate its meaning).
--
-- GRAIN includes user_id deliberately: the existing SF-2 safety cap (SAFETY_FLOOR_RATELIMIT_ENABLED)
-- acts per-user, so a future per-user TOKEN cap becomes a pure read of this table — no re-grain
-- migration later. usage_date is the UTC day (Neon CURRENT_DATE) — bill on UTC days; an AEST tenant's
-- late-evening usage lands on "today's" UTC row (visibility nuance, not a correctness issue).
-- tokens 0 with calls_count>0 means "provider didn't report usage" (Workers-AI usage is OPTIONAL),
-- never "free". Writes are fire-and-forget (waitUntil) — an answer is NEVER slowed by metering.
-- Consumer flag: LLM_USAGE_METERING_ENABLED (default off). RLS second layer per the 043/053 recipe.
-- Validate against a throwaway local Postgres before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 64) THEN

    CREATE TABLE IF NOT EXISTS llm_usage_log (
      id            BIGSERIAL PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      model         TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      usage_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      calls_count   INTEGER NOT NULL DEFAULT 1,
      tokens_in     BIGINT NOT NULL DEFAULT 0,
      tokens_out    BIGINT NOT NULL DEFAULT 0,
      first_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT llm_usage_log_day_key UNIQUE (workspace_id, model, user_id, usage_date)
    );
    CREATE INDEX IF NOT EXISTS llm_usage_log_ws_idx
      ON llm_usage_log (workspace_id, usage_date DESC);

    -- RLS second layer (043/053 recipe): the RLS-subject client sees only its GUC workspace.
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE llm_usage_log ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS llm_usage_log_workspace_policy ON llm_usage_log;
      CREATE POLICY llm_usage_log_workspace_policy ON llm_usage_log
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (64, 'G2 llm_usage_log: day-grain per-(workspace,model,user) LLM call+token accumulators — the per-tenant metering substrate (commercial-staircase prerequisite)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT count(*) FROM information_schema.tables WHERE table_name='llm_usage_log';
--   SELECT conname FROM pg_constraint WHERE conname='llm_usage_log_day_key';
