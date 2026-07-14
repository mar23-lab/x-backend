-- 062_workspace_member_soft_remove.sql · A1 (260710-B) · member removal (soft) — STAGED until operator applies.
--
-- WHY: the NEW-UI cockpit ships a "Remove from workspace" control (Design §181), but the backend had NO
-- removal path — only PATCH /members/:id/role. A hard DELETE is forbidden: workspace_members is on the
-- no-hard-delete protected list (verify-no-hard-delete-customer-tables.mjs — a membership record is
-- customer-owned history). So removal is a SOFT-remove: mark removed_at, filter it out of the roster,
-- and REVOKE the member's entitlement in the same write (else a removed member could still act post-flip).
--
-- Additive + idempotent, no backfill (existing members read removed_at = NULL = active). The consuming
-- route is flag-gated (MEMBER_REMOVAL_ENABLED, default OFF) AND the roster reads degrade if this column is
-- absent, so deploying the code before this migration applies is byte-identical to today.
--
-- Validate against a throwaway local Postgres before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 62) THEN

    ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
    -- Partial index: the roster reads filter `removed_at IS NULL`, so index only the active rows.
    CREATE INDEX IF NOT EXISTS workspace_members_active_idx
      ON workspace_members (workspace_id) WHERE removed_at IS NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (62, 'workspace_members.removed_at — soft member removal (roster filters it; entitlement revoked in the same write)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT column_name FROM information_schema.columns WHERE table_name='workspace_members' AND column_name='removed_at';
