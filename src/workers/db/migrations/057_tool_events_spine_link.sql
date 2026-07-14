-- 057_tool_events_spine_link.sql · W1 customer-governance wave (260708) · STAGED until operator applies.
--
-- WHY (G2 — the one genuine parallel-chain violation): tool_events and operation_events are today two
-- UNLINKED chains. A tool action (submit_evidence, report_tool_event, approval request via MCP) is recorded
-- in tool_events but never appears on the causal spine, so intent→packet→event→tool→artefact lineage cannot
-- be walked end-to-end and the graph projection never sees tool actions. D1 decision: COMPANION-EMISSION,
-- not merge — createToolEventRow (dal/operational-spine-store.ts) emits an operation_events row in the SAME
-- RLS transaction and stamps the two-way backref below. operation_events stays the ONE causal spine;
-- tool_events becomes a detail table hanging off it (like evidence_items). Flag-gated
-- (SPINE_TOOL_EVENT_UNIFICATION_ENABLED); flag-off = byte-identical current behaviour.
--
-- Two additive parts, both idempotent, no backfill (050's honesty stance — old rows read "not unified"):
--   1. tool_events.event_id — the backref to the companion spine event.
--   2. operation_events source_tool CHECK += 'tool_action' (the 041 pattern: the typed SourceTool union and
--      VALID_SOURCE_TOOLS gain the same value in the same commit).
--
-- Validate against a throwaway local Postgres before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 57) THEN

    -- 1. The spine backref (nullable; NO backfill; no hard FK — L1 org pointer per ADR-XLOOP-IA-001,
    --    same stance as operation_events.intent_id / parent_event_id).
    ALTER TABLE tool_events ADD COLUMN IF NOT EXISTS event_id TEXT;
    CREATE INDEX IF NOT EXISTS tool_events_workspace_event_idx
      ON tool_events (workspace_id, event_id) WHERE event_id IS NOT NULL;

    -- 2. Extend the operation_events source_tool CHECK with 'tool_action' (drop-by-name + re-add, the
    --    exact 041 recipe — the constraint name is stable since 041 re-created it).
    IF EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'operation_events_source_tool_check'
    ) THEN
      ALTER TABLE operation_events DROP CONSTRAINT operation_events_source_tool_check;
    END IF;
    ALTER TABLE operation_events ADD CONSTRAINT operation_events_source_tool_check
      CHECK (source_tool IN (
        'codex', 'claude', 'harness', 'mbp', 'xlooop', 'operator',
        'github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive',
        'folder', 'gmail', 'outlook', 'document_upload',
        'tool_action'
      ));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (57, 'W1 spine unification: tool_events.event_id backref + source_tool CHECK += tool_action', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT column_name FROM information_schema.columns WHERE table_name='tool_events' AND column_name='event_id';
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='operation_events_source_tool_check';
