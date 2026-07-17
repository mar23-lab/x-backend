-- 081_intent_status_superset.sql · W2 R2 (audit gap G6) — intent lifecycle vocabulary superset.
--
-- STAGED-ONLY: authored 2026-07-17, MUST NOT be applied to production without the operator
-- naming it (same discipline as 066/075). Numbered 081 to leave 080 (synthetic_domains RLS,
-- PR #6) its slot.
--
-- WHY: the design model (x-ai-front Architecture Map) and the frontend rail caption speak the
-- lifecycle open -> satisfied | abandoned | duplicate, but 023's CHECK admits only
-- open|active|blocked|done|abandoned — the taxonomies share ONE terminal state. Ratified by
-- ADR-ABS-011 (intent topology): the backend vocabulary grows a SUPERSET additively; nothing
-- is renamed, no rows are rewritten. `done` remains legal as a LEGACY value and will be
-- edge-mapped to `satisfied` when the frontend wiring train lands (post-cutover); until then
-- no writer emits the new values, so applying this is behaviourally inert.
--
-- Same additive-superset pattern as 069:64-67. Idempotent + version-guarded; apply MANUALLY
-- per the prod-Neon one-at-a-time pattern; read-verify before + after.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 81) THEN

    -- Drop the existing status CHECK by DISCOVERED name: 023 declared it inline, so the name
    -- is Postgres-generated and dropping a guessed literal would silently no-op, leaving TWO
    -- checks where the old one still rejects the new values.
    DECLARE
      old_check TEXT;
    BEGIN
      SELECT conname INTO old_check
      FROM pg_constraint
      WHERE conrelid = 'intents'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%status%';
      IF old_check IS NOT NULL THEN
        EXECUTE format('ALTER TABLE intents DROP CONSTRAINT %I', old_check);
      END IF;
    END;

    ALTER TABLE intents ADD CONSTRAINT intents_status_check
      CHECK (status IN ('open', 'active', 'blocked', 'done', 'abandoned', 'satisfied', 'duplicate'));

    COMMENT ON COLUMN intents.status IS
      'open|active|blocked -> live; satisfied|abandoned|duplicate -> settled (ADR-ABS-011). '
      'done = legacy completion value, edge-mapped to satisfied at the wiring train; do not emit in new writers.';

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (81, 'W2 R2: intent status CHECK superset (+satisfied,+duplicate; done=legacy) per ADR-ABS-011', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, run after apply):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='intents_status_check';
--   SELECT status, count(*) FROM intents GROUP BY 1;   -- expect NO satisfied/duplicate rows pre-wiring
