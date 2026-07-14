-- 021_governance_audit.sql · audit the governance plane (Wave 4) · 2026-06-10
--
-- audit_logs was admin-only (user/workspace approvals): the governance actions the operator actually
-- cares about for lineage — sign-offs and the event approve/reject they drive — were NOT recorded, so
-- "who approved what, when" had no trail (auditability ~4/10). This:
--   1. widens audit_logs.target_type to allow governance targets ('event', 'packet', 'decision',
--      'sign_off') alongside every existing value (additive — no existing row can be invalidated),
--   2. adds a nullable causation_id so an audit entry can point at the artefact that caused it
--      (the first link of a lineage chain: this sign-off was caused by event X).
--
-- Idempotent + version-guarded + additive (mirrors 019/020). The CHECK is dropped-and-recreated by
-- its live name inside the same transaction, so the table is never without the constraint. Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/021_governance_audit.sql

BEGIN;

DO $$
DECLARE cn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 21) THEN
    -- Drop the existing target_type CHECK by whatever name it carries, then recreate as a superset.
    SELECT conname INTO cn
      FROM pg_constraint
      WHERE conrelid = 'audit_logs'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%target_type%'
      LIMIT 1;
    IF cn IS NOT NULL THEN EXECUTE format('ALTER TABLE audit_logs DROP CONSTRAINT %I', cn); END IF;

    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_target_type_check CHECK (target_type IN (
      'user', 'workspace_member', 'access_request', 'workspace', 'project',
      'synthetic_domain', 'synthetic_domain_roadmap', 'synthetic_domain_roadmap_item',
      'synthetic_domain_goal', 'synthetic_domain_propagation_rule', 'synthetic_domain_recommendation',
      'event', 'packet', 'decision', 'sign_off'
    ));

    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS causation_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_audit_logs_causation ON audit_logs(causation_id) WHERE causation_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (21, 'governance audit: target_type +event/packet/decision/sign_off + causation_id', now());
  END IF;
END $$;

COMMIT;
