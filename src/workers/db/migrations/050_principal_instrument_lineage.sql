-- 050_principal_instrument_lineage.sql · A-W4/P6 · principal + instrument actor lineage · 2026-07-07
--
-- WHY (the AI-governance differentiator): today operation_events records only the INSTRUMENT (`agent_id` —
-- what emitted the event) and the surface (`source_tool`). An enterprise auditor's question — "WHO
-- AUTHORIZED this AI/tool action, and under what authority?" — has no column. This adds the principal half
-- of the actor model, matching the new UI's doctrine verbatim: audit records principal + instrument
-- ("Claude · acting for Andrey"), never just "by Andrey".
--
--   authorized_by_user_id  TEXT  — the human principal who authorized the write (NULL only for pure
--                                  system-policy writes, e.g. scheduled digests)
--   instrument_kind        TEXT  — the UI's ACTOR_KIND enum: human | agent | system | external
--                                  (an API token is NOT a kind — it is authority_source 'token_scope')
--   authority_source       TEXT  — role | explicit_approval | token_scope | system_policy | operator_identity
--   request_id             TEXT  — HTTP correlation id (the UI's chat `turn` is a SEPARATE, deferred concept)
--
-- ADDITIVE + BEHAVIOR-PRESERVING: all four columns are NULLABLE, existing `agent_id`/`source_tool`
-- semantics untouched, no backfill (new writes only — old rows honestly read "lineage not recorded").
-- Vocabulary SSOT: src/workers/lib/actor-lineage.ts (drift frozen by verify:principal-instrument-lineage).
--
-- Idempotent + version-guarded. Apply MANUALLY (operator-named), read-verify before + after. Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/050_principal_instrument_lineage.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 50) THEN
    ALTER TABLE operation_events ADD COLUMN IF NOT EXISTS authorized_by_user_id TEXT;
    ALTER TABLE operation_events ADD COLUMN IF NOT EXISTS instrument_kind TEXT;
    ALTER TABLE operation_events ADD COLUMN IF NOT EXISTS authority_source TEXT;
    ALTER TABLE operation_events ADD COLUMN IF NOT EXISTS request_id TEXT;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'operation_events'::regclass AND conname = 'operation_events_instrument_kind_check'
    ) THEN
      ALTER TABLE operation_events ADD CONSTRAINT operation_events_instrument_kind_check
        CHECK (instrument_kind IS NULL OR instrument_kind IN ('human', 'agent', 'system', 'external'));
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'operation_events'::regclass AND conname = 'operation_events_authority_source_check'
    ) THEN
      ALTER TABLE operation_events ADD CONSTRAINT operation_events_authority_source_check
        CHECK (authority_source IS NULL OR authority_source IN
          ('role', 'explicit_approval', 'token_scope', 'system_policy', 'operator_identity'));
    END IF;

    -- Partial index: "what did principal X authorize in this workspace" — the auditor query.
    CREATE INDEX IF NOT EXISTS idx_events_authorized_by
      ON operation_events (workspace_id, authorized_by_user_id)
      WHERE authorized_by_user_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (50, 'principal-instrument actor lineage on operation_events (A-W4/P6)', now());
  END IF;
END $$;

COMMIT;
