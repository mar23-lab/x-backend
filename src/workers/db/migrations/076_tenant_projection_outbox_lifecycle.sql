-- 076_tenant_projection_outbox_lifecycle.sql · STAGED ONLY, never auto-applied.
-- Adds explicit dispatch/process/dead-letter lifecycle to the transactional outbox created by 075.
-- No queue is provisioned and no runtime flag is enabled by this migration.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 76) THEN
    ALTER TABLE projection_outbox ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE projection_outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
    ALTER TABLE projection_outbox ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
    ALTER TABLE projection_outbox ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
    ALTER TABLE projection_outbox ADD COLUMN IF NOT EXISTS last_error_code TEXT;
    ALTER TABLE projection_outbox ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

    ALTER TABLE projection_outbox DROP CONSTRAINT IF EXISTS projection_outbox_status_check;
    ALTER TABLE projection_outbox ADD CONSTRAINT projection_outbox_status_check
      CHECK (status IN ('pending','dispatching','dispatched','processing','processed','dead_letter'));
    ALTER TABLE projection_outbox DROP CONSTRAINT IF EXISTS projection_outbox_last_error_code_check;
    ALTER TABLE projection_outbox ADD CONSTRAINT projection_outbox_last_error_code_check
      CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 80);

    UPDATE projection_outbox SET status = 'processed' WHERE processed_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_projection_outbox_dispatch
      ON projection_outbox(status, created_at) WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_projection_outbox_workspace_status
      ON projection_outbox(workspace_id, status, created_at);

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (76, 'tenant projection outbox dispatch, retry, processing and dead-letter lifecycle; staged default-off', now());
  END IF;
END $$;

COMMIT;
