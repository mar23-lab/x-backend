-- 067_user_source_connection_read_policy.sql · G2 (260711) · source access-level (L1/L2/L3) — STAGED until operator applies.
--
-- WHY (write 25 · the NEW-UI source access-level badge is optimistic-only today): the cockpit lets a
-- customer set a per-source access level (Index / Rely / Operate), but `user_source_connections` had NO
-- column to persist it — the FE flags `levelChangeBackendPending:true`. This adds the missing column.
--
-- REUSE THE EXACT 016 VOCABULARY: `project_source_bindings.read_policy` already uses
-- metadata_only / read_only / proposal_only, and `services/source-tier.ts readPolicyToTier` maps them to
-- Index / Rely / Operate. Reusing the SAME enum here means that mapper works unchanged (no new enum).
--   metadata_only → Index (L1)   ·   read_only → Rely (L2)   ·   proposal_only → Operate (L3)
--
-- Additive + idempotent, no backfill (existing rows default to 'metadata_only' = the safest tier). The
-- consuming PATCH route degrades if this column is absent, so deploying code before this migration
-- applies is byte-identical to today. Validate against a throwaway local Postgres before commit; prod
-- apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 67) THEN

    ALTER TABLE user_source_connections
      ADD COLUMN IF NOT EXISTS read_policy TEXT NOT NULL DEFAULT 'metadata_only'
      CHECK (read_policy IN ('metadata_only','proposal_only','read_only'));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (67, 'user_source_connections.read_policy — per-source access tier (reuses 016 metadata_only/read_only/proposal_only enum; source-tier.ts maps to Index/Rely/Operate)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT column_name, column_default, is_nullable FROM information_schema.columns
--     WHERE table_name='user_source_connections' AND column_name='read_policy';
--   SELECT conname FROM pg_constraint WHERE conrelid='user_source_connections'::regclass AND contype='c';
