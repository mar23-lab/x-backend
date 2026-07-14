-- 054_customer_entitlements_workspace_grain.sql · Wave OA-cutover-stage (260708) · STAGED, NOT APPLIED.
--
-- WHY: customer_entitlements (migration 018) is keyed UNIQUE(user_id, app_id) — a PER-USER grain that cannot
-- express per-workspace authority. Prod is multi-workspace (11 active memberships / 4 distinct users), so a
-- per-user row would let operator authority in workspace A leak into workspace B for the same user. The
-- operator decision (260708) is PER-(user, workspace) grain: change the unique key to
-- UNIQUE(user_id, workspace_id, app_id). The reader (dal/entitlement-store.ts) already scopes by workspace_id.
--
-- SAFE: the table is EMPTY in prod (0 rows, verified) so the constraint swap cannot conflict. This migration
-- is a prerequisite for 055 (the per-workspace role-mirror backfill). NOTHING reads customer_entitlements in
-- production yet (resolvePrincipal is built but unwired) — applying 054+055 only populates an unread table.
--
-- Idempotent + version-guarded. Prod apply is OPERATOR-NAMED + manual, read-verify before + after. Validate
-- against a throwaway local Postgres first. NOTE: workspace_id is NULLABLE (a future personal/global
-- entitlement); the backfill always sets it, so the composite unique enforces per-workspace uniqueness for
-- every real row (NULL workspace_ids are distinct under a UNIQUE index — acceptable, none are created here).

BEGIN;

DO $$
DECLARE cn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 54) THEN

    -- Drop the old per-user unique BY ITS LIVE NAME (it is 'customer_entitlements_user_id_app_id_key' today,
    -- but resolve dynamically so this is robust).
    SELECT conname INTO cn FROM pg_constraint
      WHERE conrelid = 'customer_entitlements'::regclass AND contype = 'u'
        AND pg_get_constraintdef(oid) = 'UNIQUE (user_id, app_id)'
      LIMIT 1;
    IF cn IS NOT NULL THEN
      EXECUTE format('ALTER TABLE customer_entitlements DROP CONSTRAINT %I', cn);
    END IF;

    -- Add the per-(user, workspace) unique (idempotent via the name guard).
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'customer_entitlements'::regclass AND conname = 'customer_entitlements_user_ws_app_key'
    ) THEN
      ALTER TABLE customer_entitlements
        ADD CONSTRAINT customer_entitlements_user_ws_app_key UNIQUE (user_id, workspace_id, app_id);
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (54, 'customer_entitlements per-(user,workspace) grain — UNIQUE(user_id,workspace_id,app_id)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid='customer_entitlements'::regclass AND contype='u';   -- expect UNIQUE (user_id, workspace_id, app_id)
--   SELECT version FROM workers_schema_version WHERE version = 54;         -- expect 1 row
