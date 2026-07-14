-- 058_chat_receipt_grounding.sql · W1 customer-governance wave (260708) · STAGED until operator applies.
--
-- WHY (G4 — chat answers are not customer-auditable): chat_messages.grounded_on (migration 020) is a FROZEN
-- JSONB snapshot of what the model saw — evidence-at-time-of-answer, kept unchanged. But it has no LIVE link
-- to the operation_events that grounded the answer, so a customer can neither click through from an answer to
-- the events behind it, nor ask the reverse ("which AI answers were grounded on event X?" — the regulated-SMB
-- differentiator). D2 decision: keep the snapshot, ADD the navigable links:
--   1. grounding_event_ids TEXT[] — the operation_events ids that entered grounding (GIN-indexed for the
--      reverse query). Different data class from the snapshot, not a duplicate.
--   2. receipt_uid — a non-guessable public receipt key (msg ids are 'msg_' + timestamp-ish; receipts get
--      their own opaque uid) for GET /api/v1/chat/receipt/:receipt_uid (W2).
-- Nullable, new-writes-only (050 honesty stance: old messages read "no receipt available").
--
-- Validate against a throwaway local Postgres before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 58) THEN

    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS grounding_event_ids TEXT[];
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS receipt_uid TEXT;

    -- Reverse query: "answers grounded on event X" (partial — only rows that carry links).
    CREATE INDEX IF NOT EXISTS chat_messages_grounding_event_ids_gin
      ON chat_messages USING GIN (grounding_event_ids)
      WHERE grounding_event_ids IS NOT NULL;

    -- Receipt lookup key (unique among rows that have one).
    CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_receipt_uid_key
      ON chat_messages (receipt_uid) WHERE receipt_uid IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (58, 'W1 chat receipt substrate: grounding_event_ids TEXT[] (GIN) + receipt_uid on chat_messages', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT column_name FROM information_schema.columns WHERE table_name='chat_messages'
--     AND column_name IN ('grounding_event_ids','receipt_uid');
