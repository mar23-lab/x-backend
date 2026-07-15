-- 079_commercial_completion_lineage.sql · STAGED ONLY; no production apply or activation.
-- Persists customer-safe intake governance/prior-work evidence and atomically links each governed
-- execution receipt to its closing attestation. Depends on migrations 070 and 075.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 79) THEN
    ALTER TABLE intake_resolutions
      ADD COLUMN prior_work JSONB NOT NULL DEFAULT '{"discovery_executed":true,"active_work_count":0,"pending_approval_count":0,"digest_sha256":""}'::jsonb,
      ADD COLUMN governance_summary TEXT NOT NULL DEFAULT 'Governance summary unavailable',
      ADD COLUMN role_label TEXT NOT NULL DEFAULT 'Workspace member',
      ADD COLUMN approach_label TEXT NOT NULL DEFAULT 'Governed operation',
      ADD COLUMN grounding_summary TEXT NOT NULL DEFAULT 'No grounding summary',
      ADD COLUMN guardrails TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN freshness JSONB NOT NULL DEFAULT '{}'::jsonb;

    -- Nullable only for receipts created before this staged migration. The runtime always supplies the
    -- value for new executions; the pilot gate must report/reconcile any historical NULL rows before soak.
    ALTER TABLE governed_execution_receipts
      ADD COLUMN closing_attestation_id TEXT REFERENCES closing_attestations(id) ON DELETE RESTRICT;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
      GRANT INSERT ON closing_attestations TO xlooop_app;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (79, 'staged customer-safe intake governance/prior-work evidence and atomic governed execution closeout linkage; no activation', now());
  END IF;
END $$;

COMMIT;
