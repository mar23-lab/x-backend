-- 051_documents_version_chain.sql · A-W5 · documents content-hash + version chain (evidence integrity) · 2026-07-07
--
-- WHY: evidence_items pin to a document by `uri` + a nullable `content_hash`, but documents themselves
-- carry NO content hash — so evidence cannot reliably prove "the exact bytes I cited are still these bytes",
-- and a re-uploaded document becomes a NEW unrelated row (no version lineage). The new UI models artefacts
-- with a version + a restorable predecessor ("v1 draft → v2 published"). This adds the backend half:
--   content_hash  TEXT  — SHA-256 (hex) of the document's content bytes; the immutable version identity.
--                        Evidence integrity: an evidence content_hash can be matched to documents.content_hash.
--   version       INT   — 1-based version number within a supersedes chain (default 1).
--   supersedes_id TEXT  — the prior version's document id (self-chain); NULL for a first upload.
--
-- Documents are already CONTENT-IMMUTABLE (only status/admissibility metadata is ever UPDATEd), so a
-- content_hash is stable for the life of a row. content_hash is BACKFILLED deterministically from the
-- stored bytes (safe, no data change) — the ONE exception to no-backfill, because a version identity is
-- worthless if existing evidence-referenced docs lack it. version/supersedes are new-writes-only.
--
-- Additive + idempotent + version-guarded. Apply MANUALLY (operator-named), read-verify before + after.
--   psql "$DATABASE_URL" -f src/workers/db/migrations/051_documents_version_chain.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 51) THEN
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS supersedes_id TEXT;

    -- Deterministic backfill of the version identity for existing rows (SHA-256 hex of the content bytes).
    UPDATE documents SET content_hash = encode(sha256(content), 'hex') WHERE content_hash IS NULL;

    -- Evidence-integrity lookup: "which document(s) have exactly these bytes" + version-chain walk.
    CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents (workspace_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_documents_supersedes ON documents (supersedes_id) WHERE supersedes_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (51, 'documents content_hash + version + supersedes_id (A-W5 version chain / evidence integrity)', now());
  END IF;
END $$;

COMMIT;
