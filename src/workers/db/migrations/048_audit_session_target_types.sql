-- 048_audit_session_target_types.sql · widen audit_logs.target_type for session-event audit (E2) · 2026-07-07
--
-- WHY: the governance audit trail (021) records event/packet/decision/sign_off targets, but the SESSION
-- lifecycle an enterprise auditor asks for — API-token mint/revoke and sign-in/out — has no valid
-- target_type, so those rows cannot be written (the 021 CHECK would reject them). This widens the CHECK
-- to a SUPERSET adding 'api_token' and 'session', so the route layer can record token mint/revoke and
-- session events into the SAME audit_logs trail the /audit-log export already reads.
--
-- Additive + idempotent + version-guarded (mirrors 021): every existing target_type stays valid, so no
-- existing row is invalidated. The CHECK is dropped-by-live-name and recreated inside one transaction, so
-- the table is never without the constraint.
--
-- SAFE / INERT-UNTIL-WIRED: widening the allow-list writes no rows. The token/session audit INSERTs that
-- use these target_types are best-effort (try/catch) and land only after this migration is applied.
-- Apply MANUALLY (operator-named), one at a time — read-verify the CHECK before + after. Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/048_audit_session_target_types.sql

BEGIN;

DO $$
DECLARE cn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 48) THEN
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
      'event', 'packet', 'decision', 'sign_off',
      'api_token', 'session'
    ));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (48, 'audit target_type superset +api_token +session (E2 session-event audit)', now());
  END IF;
END $$;

COMMIT;
