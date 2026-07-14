-- 041_operation_events_source_tool_document_upload.sql
-- P4 (260629) · Single-intake governance fix — operation_events.source_tool CHECK.
--
-- WHY (live-confirmed latent bug): the documents route (#791) emitted operation_events with
-- source_tool = 'document-upload' via a bespoke raw INSERT (lib/document-store.insertDocumentEventRow) that
-- BYPASSED the typed canonical path (dal/event-store.upsertEventRow, whose source_tool is typed SourceTool).
-- 'document-upload' is in NO CHECK constraint and NOT in the SourceTool union / VALID_SOURCE_TOOLS, so the
-- INSERT violated operation_events_source_tool_check and was swallowed by a best-effort try/catch → the
-- governed "document added" audit event silently never landed. Confirmed on prod (flat-truth-23350426):
-- the CHECK stopped at 'folder'; documents_stored = 0, so the bug is LATENT (would fire on the first real upload).
--
-- THIS MIGRATION:
--   1. Adds 'document_upload' (snake_case — sibling to google_drive/microsoft_onedrive; a SYSTEM-emitted
--      direct-upload channel, present in the SourceTool type + this CHECK but deliberately NOT in the
--      caller-suppliable VALID_SOURCE_TOOLS — see docs/engineering/INTAKE_CONTRACT.md §V3).
--   2. Restores 'gmail' + 'outlook' (migrations 039/040 intent) — prod's CHECK had drifted behind to
--      [..., 'folder'], so this re-aligns prod's CHECK with the canonical SourceTool union in one pass.
--   (Code side: documents.ts now routes through the typed upsertEventRow; the raw INSERT helper is removed and
--    the verify:no-raw-operation-events-insert gate forbids re-adding one outside the canonical DAL stores.)
--
-- SAFETY: operation_events is small (low thousands of rows) so the implicit validating scan on DROP+ADD is
-- trivial; this is a WIDENING CHECK (every existing row already satisfies it). If the table ever grows large,
-- switch to ADD CONSTRAINT ... NOT VALID + a separate VALIDATE CONSTRAINT (weaker lock) across two transactions.
-- IDEMPOTENT: version-guarded (workers_schema_version = 41). Safe to re-run.
-- APPLY MANUALLY one-at-a-time against prod Neon per the prod-migration discipline (NOT auto-run on boot).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 41) THEN
    RAISE NOTICE 'migration 41 already applied - skipping';
    RETURN;
  END IF;

  -- Drop the existing CHECK (auto-generated name from 001_init.sql, last rebuilt by 008/026/039/040).
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operation_events_source_tool_check'
  ) THEN
    ALTER TABLE operation_events DROP CONSTRAINT operation_events_source_tool_check;
  END IF;

  -- Re-add the FULL canonical set (matches the SourceTool union in src/workers/dal/types/event.ts).
  ALTER TABLE operation_events
    ADD CONSTRAINT operation_events_source_tool_check
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
      'gmail',
      'outlook',
      'document_upload'
    ));

  INSERT INTO workers_schema_version (version, applied_at, description)
  VALUES (
    41,
    now(),
    'P4 · operation_events.source_tool CHECK: add document_upload (system direct-upload channel) + restore gmail/outlook (039/040 prod drift) - aligns prod CHECK with the SourceTool union; fixes silent document-audit-event loss'
  );
END $$;
