-- 073_packet_completion_contract.sql · version-bound packet completion facts — STAGED ONLY.
--
-- Additive schema for the default-off server-derived completion evaluator. This migration does not
-- mark any packet complete and must not be applied to production without Marat's explicit cutover
-- approval. Existing packets default to conservative facts and therefore cannot gain authority.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 73) THEN
    ALTER TABLE task_packets
      ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      ADD COLUMN IF NOT EXISTS requested_output TEXT,
      ADD COLUMN IF NOT EXISTS acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS acceptance_status TEXT NOT NULL DEFAULT 'not_required'
        CHECK (acceptance_status IN ('not_required', 'pending', 'passed', 'failed')),
      ADD COLUMN IF NOT EXISTS evidence_required BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (execution_status IN ('not_required', 'pending', 'running', 'succeeded', 'failed')),
      ADD COLUMN IF NOT EXISTS blockers_accepted BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS receipt_required BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS plan_projection_required BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS plan_projection_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

    ALTER TABLE task_packets
      DROP CONSTRAINT IF EXISTS task_packets_acceptance_criteria_array;
    ALTER TABLE task_packets
      ADD CONSTRAINT task_packets_acceptance_criteria_array
      CHECK (jsonb_typeof(acceptance_criteria) = 'array');

    ALTER TABLE approval_requests
      ADD COLUMN IF NOT EXISTS packet_version INTEGER CHECK (packet_version IS NULL OR packet_version >= 1);

    CREATE INDEX IF NOT EXISTS idx_approval_requests_packet_version
      ON approval_requests(workspace_id, packet_id, packet_version, status);

    CREATE OR REPLACE FUNCTION xlooop_bind_approval_packet_version()
    RETURNS TRIGGER LANGUAGE plpgsql AS $APPROVAL$
    DECLARE current_packet_version INTEGER;
    BEGIN
      IF NEW.packet_id IS NULL THEN
        NEW.packet_version := NULL;
        RETURN NEW;
      END IF;
      SELECT version INTO current_packet_version
        FROM task_packets
       WHERE id = NEW.packet_id AND workspace_id = NEW.workspace_id;
      IF current_packet_version IS NULL THEN
        RAISE EXCEPTION 'packet_id does not exist in approval workspace';
      END IF;
      IF NEW.packet_version IS NOT NULL AND NEW.packet_version <> current_packet_version THEN
        RAISE EXCEPTION 'approval packet_version does not match current packet version';
      END IF;
      NEW.packet_version := current_packet_version;
      RETURN NEW;
    END;
    $APPROVAL$;

    DROP TRIGGER IF EXISTS trg_approval_packet_version ON approval_requests;
    CREATE TRIGGER trg_approval_packet_version
      BEFORE INSERT OR UPDATE OF packet_id, packet_version, workspace_id ON approval_requests
      FOR EACH ROW EXECUTE FUNCTION xlooop_bind_approval_packet_version();

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (73, 'version-bound packet completion facts, same-workspace approval binding, and approval packet_version; default-off server-derived evaluator; no completion transition', now());
  END IF;
END $$;

COMMIT;

-- Read-only verification after an explicitly approved non-production apply:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='task_packets' AND column_name IN
--    ('version','requested_output','acceptance_criteria','acceptance_status','evidence_required',
--     'execution_status','blockers_accepted','receipt_required','plan_projection_required',
--     'plan_projection_updated_at','completed_at'); -- expect 11
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='approval_requests' AND column_name='packet_version'; -- expect 1
