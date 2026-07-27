-- 091_conversation_interaction_lineage.sql
-- Additive conversation lineage for project-scoped Ask/Plan/Do continuity.
--
-- This migration extends the existing chat_threads/chat_messages aggregate. It does not create a
-- competing conversation store. Nullable references preserve historical rows; new strict writes use
-- interaction_id + entry_type to make each user request, answer, preview, outcome, and failure
-- idempotent inside its canonical scope thread.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 91) THEN
    ALTER TABLE intake_resolutions
      ADD COLUMN IF NOT EXISTS interaction_id TEXT;

    ALTER TABLE governed_execution_receipts
      ADD COLUMN IF NOT EXISTS interaction_id TEXT,
      ADD COLUMN IF NOT EXISTS intent_id TEXT,
      ADD COLUMN IF NOT EXISTS operation_event_id TEXT,
      ADD COLUMN IF NOT EXISTS audit_event_id TEXT,
      ADD COLUMN IF NOT EXISTS projection_outbox_id TEXT,
      ADD COLUMN IF NOT EXISTS conversation_message_id BIGINT;

    ALTER TABLE chat_messages
      ADD COLUMN IF NOT EXISTS interaction_id TEXT,
      ADD COLUMN IF NOT EXISTS entry_type TEXT,
      ADD COLUMN IF NOT EXISTS resolution_id TEXT,
      ADD COLUMN IF NOT EXISTS execution_receipt_id TEXT,
      ADD COLUMN IF NOT EXISTS packet_id TEXT,
      ADD COLUMN IF NOT EXISTS operation_event_id TEXT,
      ADD COLUMN IF NOT EXISTS intent_id TEXT,
      ADD COLUMN IF NOT EXISTS audit_event_id TEXT,
      ADD COLUMN IF NOT EXISTS closing_attestation_id TEXT;

    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_entry_type_check_v91
      CHECK (
        entry_type IS NULL OR entry_type IN (
          'user_request',
          'assistant_answer',
          'resolution_preview',
          'execution_outcome',
          'system_failure'
        )
      ) NOT VALID;

    ALTER TABLE chat_messages
      VALIDATE CONSTRAINT chat_messages_entry_type_check_v91;

    CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_interaction_entry_key
      ON chat_messages(thread_id, interaction_id, entry_type)
      WHERE interaction_id IS NOT NULL AND entry_type IS NOT NULL;

    CREATE INDEX IF NOT EXISTS chat_messages_execution_receipt
      ON chat_messages(execution_receipt_id)
      WHERE execution_receipt_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS chat_messages_resolution
      ON chat_messages(resolution_id)
      WHERE resolution_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS intake_resolutions_interaction
      ON intake_resolutions(workspace_id, actor_user_id, interaction_id)
      WHERE interaction_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS governed_execution_receipts_interaction
      ON governed_execution_receipts(workspace_id, actor_user_id, interaction_id)
      WHERE interaction_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (
      91,
      'Additive project-scoped conversation interaction lineage, exactly-once entry identity, and governed execution authority references',
      now()
    );
  END IF;
END $$;

COMMIT;

-- Read-only verification after an approved apply:
--   SELECT column_name
--   FROM information_schema.columns
--   WHERE table_name IN ('intake_resolutions','governed_execution_receipts','chat_messages')
--     AND column_name IN (
--       'interaction_id','entry_type','resolution_id','execution_receipt_id','packet_id',
--       'operation_event_id','intent_id','audit_event_id','closing_attestation_id'
--     )
--   ORDER BY column_name;
