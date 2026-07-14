-- 055_customer_entitlements_role_backfill.sql · Wave OA-cutover-stage (260708) · STAGED, NOT APPLIED.
--
-- WHY: customer_entitlements is EMPTY in every environment (0 rows, 0 writers — verified). Enabling
-- fail-closed entitlement-backed auth against an empty table would deny EVERY user (incl. the owner) — a 100%
-- write lockout, not a tightening. This backfill grants each ACTIVE workspace membership an entitlement that
-- REPRODUCES today's write authority exactly, so the eventual cutover (wiring resolvePrincipal) is
-- behaviour-preserving and lockout-free. Tightening to real least-privilege happens LATER as a curated data op.
--
-- Per-(user, workspace) grain (operator decision 260708) — one row PER ACTIVE MEMBERSHIP (prod: 11), keyed
-- ON CONFLICT (user_id, workspace_id, app_id). Requires migration 054 (the composite unique) first.
--
-- Role mirror (matches modesForRole + today's write semantics):
--   owner, operator → allowed_modes ['watch','test','operator'], allowed_actions ['*'], denied []
--   viewer          → allowed_modes ['watch'],                    allowed_actions [],    denied []
--   client          → allowed_modes ['watch'],                    allowed_actions [],    denied ['*']
--
-- granted_by = the workspace owner (a real users(id); the granted_by FK is satisfied — prod pre-checked:
-- 11/11 memberships have a valid owner, 0 orphans). Idempotent: ON CONFLICT DO NOTHING never clobbers a
-- curated row + the version guard runs the body once. Prod apply is OPERATOR-NAMED; read-verify the row count
-- equals the active-membership count after apply. Nothing reads these rows until resolvePrincipal is wired.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 55) THEN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_entitlements') THEN

      INSERT INTO customer_entitlements
        (id, user_id, workspace_id, app_id, account_type,
         allowed_modes, allowed_actions, denied_actions,
         authority_ref, granted_at, granted_by, created_at, updated_at)
      SELECT
        'cent_' || replace(gen_random_uuid()::text, '-', ''),
        wm.user_id,
        wm.workspace_id,
        'xlooop-product',
        'company',
        CASE WHEN wm.role IN ('owner', 'operator') THEN ARRAY['watch','test','operator']::TEXT[]
             ELSE ARRAY['watch']::TEXT[] END,
        CASE WHEN wm.role IN ('owner', 'operator') THEN ARRAY['*']::TEXT[]
             ELSE ARRAY[]::TEXT[] END,
        CASE WHEN wm.role = 'client' THEN ARRAY['*']::TEXT[]
             ELSE ARRAY[]::TEXT[] END,
        'backfill:055:role-mirror',
        now(),
        w.owner_user_id,               -- granted_by → users(id); the workspace owner is a real user
        now(), now()
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.status = 'active'
      ON CONFLICT (user_id, workspace_id, app_id) DO NOTHING;

    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (55, 'per-(user,workspace) role-mirror backfill of customer_entitlements — no-lockout cutover', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply — MUST hold before wiring resolvePrincipal):
--   SELECT count(*) FROM customer_entitlements WHERE app_id='xlooop-product';           -- expect = active members (prod: 11)
--   SELECT count(*) FROM workspace_members WHERE status='active';                       -- must equal the above
--   SELECT workspace_id, allowed_modes FROM customer_entitlements ORDER BY workspace_id LIMIT 5;  -- owner/operator → operator mode
