-- 049_documents_admissibility.sql · M6 · AI-context admissibility state on documents · 2026-07-07
--
-- WHY (P11, the unique-to-category control): "what may enter the model's context" becomes an EXPLICIT,
-- per-item, governed state instead of an implicit "any doc with extracted_text grounds". This adds the
-- new UI's 4-state admissibility enum (visible | excluded | candidate | approved) to documents, so an
-- operator can EXCLUDE a document from the chief-of-staff's context (or hold it as a candidate pending
-- review) and that decision is enforced at the grounding read.
--
-- BEHAVIOR-PRESERVING backfill: the column DEFAULT is 'approved', so every EXISTING document (and every
-- new upload) keeps grounding exactly as today — the felt-pain fix "uploaded docs answer questions" is
-- untouched. The control's value is the explicit exclude/candidate action, which drops an item from
-- context. (A future policy flag may flip the default to opt-in 'candidate'; not this migration.)
--
-- Additive + idempotent + version-guarded. ADD COLUMN IF NOT EXISTS + a named CHECK created only when
-- absent. Apply MANUALLY (operator-named), read-verify before + after. Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/049_documents_admissibility.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 49) THEN
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS admissibility TEXT NOT NULL DEFAULT 'approved';

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'documents'::regclass AND conname = 'documents_admissibility_check'
    ) THEN
      ALTER TABLE documents ADD CONSTRAINT documents_admissibility_check
        CHECK (admissibility IN ('visible', 'excluded', 'candidate', 'approved'));
    END IF;

    -- Partial index: the grounding read filters to context-admissible rows; keep that lookup cheap.
    CREATE INDEX IF NOT EXISTS idx_documents_admissibility
      ON documents (workspace_id, admissibility);

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (49, 'documents.admissibility 4-state enum (M6 AI-context admissibility)', now());
  END IF;
END $$;

COMMIT;
