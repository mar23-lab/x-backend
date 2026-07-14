-- 030_decisions.sql · first-class DECISIONS artefact (raise Decision 2/10 -> a real record) · 2026-06-11
-- A "decision" was implicit: operation_events.status flips + sign_offs rows + audit_logs(target_type='decision').
-- 'decision' already exists as an audit target_type (021) and a graph PACKET_KIND (data-graph.ts) but nothing
-- materializes behind it. This adds the RICH record a sign-off does NOT carry (context/criteria/rollback/causation)
-- while REUSING sign_offs as the approval act + audit_logs as the trail — no duplication. No hard FK to
-- operation_events/sign_offs (loose coupling, mirrors 023_first_class_intents) so a missing/late event never blocks.
-- Idempotent + version-guarded + additive (mirrors 023/029). Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/030_decisions.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 30) THEN
    CREATE TABLE IF NOT EXISTS decisions (
      id            TEXT PRIMARY KEY,            -- 'decision-<uuid>'
      workspace_id  TEXT NOT NULL,               -- tenant scope (kept loose like intents/audit_logs)
      project_id    TEXT,                        -- optional narrowing
      event_id      TEXT,                        -- the operation_events row this decision was made ON; loose
      actor_user_id TEXT NOT NULL,               -- who decided
      kind          TEXT NOT NULL DEFAULT 'governance'
                      CHECK (kind IN ('governance','technical','product','commercial','operational')),
      verdict       TEXT NOT NULL
                      CHECK (verdict IN ('approved','rejected','deferred','noted')),
      context       TEXT NOT NULL,               -- the rich rationale a sign-off comment cannot hold
      criteria      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- decision criteria / options weighed
      rollback      TEXT,                        -- the reversal plan (governance maturity signal)
      causation_id  TEXT,                        -- the cause artefact (event/intent/decision id) this followed from
      decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_decisions_workspace_time ON decisions(workspace_id, decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id) WHERE project_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_decisions_event ON decisions(event_id) WHERE event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_decisions_causation ON decisions(causation_id) WHERE causation_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (30, 'first-class decisions artefact (context/criteria/rollback/causation) reusing sign_offs+audit_logs', now());
  END IF;
END $$;

COMMIT;
