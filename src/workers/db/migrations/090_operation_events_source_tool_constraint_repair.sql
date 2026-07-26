-- 090_operation_events_source_tool_constraint_repair.sql
-- Repair operation_events.source_tool semantic drift without rewriting existing rows.
--
-- WHY: migrations 041 and 057 widened this CHECK for document_upload and tool_action,
-- but migration 040 was later applied out of order and rebuilt the older vocabulary.
-- workers_schema_version therefore reported a current schema while the live object was
-- stale. This forward-only repair restores the full SourceTool contract. Historical
-- migrations remain immutable evidence of what was applied.
--
-- LOCKING: ADD ... NOT VALID avoids a validating scan while holding the add-constraint
-- lock. VALIDATE performs the scan with a weaker lock. The final drop/rename requires
-- only brief catalog locks. This is a widening constraint, so existing valid rows remain
-- valid throughout: the new constraint is validated before the old one is removed.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 90) THEN
    ALTER TABLE operation_events
      ADD CONSTRAINT operation_events_source_tool_check_v90
      CHECK (source_tool IN (
        'codex',
        'claude',
        'harness',
        'mbp',
        'xlooop',
        'operator',
        'github',
        'google_drive',
        'dropbox',
        'gitlab',
        'microsoft_onedrive',
        'folder',
        'tool_action',
        'gmail',
        'outlook',
        'document_upload'
      )) NOT VALID;

    ALTER TABLE operation_events
      VALIDATE CONSTRAINT operation_events_source_tool_check_v90;

    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'operation_events'::regclass
        AND conname = 'operation_events_source_tool_check'
    ) THEN
      ALTER TABLE operation_events
        DROP CONSTRAINT operation_events_source_tool_check;
    END IF;

    ALTER TABLE operation_events
      RENAME CONSTRAINT operation_events_source_tool_check_v90
      TO operation_events_source_tool_check;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (
      90,
      'Repair operation_events.source_tool CHECK after out-of-order migration 040 reverted document_upload/tool_action; restore exact SourceTool vocabulary with validate-before-swap'
    , now());
  END IF;
END $$;

COMMIT;

-- Verify after apply:
--   SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'operation_events'::regclass
--     AND conname = 'operation_events_source_tool_check';
