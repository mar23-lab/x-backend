-- src/workers/db/migrations/038_documents.sql
-- Stage 2 (source-intake, 260628) · customer document upload + ingestion storage.
--
-- STORAGE = Neon `bytea`. R2 object storage is the scale-up once it is enabled on the Cloudflare
-- account (wrangler returns code 10042 "enable R2 through the Dashboard" today). The DAL abstracts
-- read/write so swapping bytea -> R2 later is a localized change.
--
-- SECURITY (the doc's stop-conditions): every document is TENANT-SCOPED — workspace_id is NOT NULL,
-- so there is no global document; the upload / list / get endpoints filter strictly by the requesting
-- session's auth.workspace_id, so a document is never readable cross-tenant. A 5 MB per-file cap is
-- enforced at the column (CHECK) AND in the endpoint. content_type is allow-listed in the endpoint.
--
-- Idempotent (IF NOT EXISTS / version-guarded) so it is safe to apply once to prod Neon and re-apply.

CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  project_id     TEXT,
  filename       TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  content        BYTEA NOT NULL,
  extracted_text TEXT,
  uploaded_by    TEXT,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'stored',
  CONSTRAINT documents_size_cap CHECK (size_bytes >= 0 AND size_bytes <= 5242880)
);

CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents (workspace_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_project   ON documents (project_id) WHERE project_id IS NOT NULL;
