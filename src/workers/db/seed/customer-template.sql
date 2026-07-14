-- customer-template.sql · Per-customer onboarding seed
--
-- Usage:
--   1. Copy this file to a customer-specific name (NOT committed; gitignored):
--      cp customer-template.sql ../../../../.seed-customer-<slug>.sql
--   2. Fill in the placeholders (search for $REPLACE_ME)
--   3. Run against production DB:
--      psql $DATABASE_URL -f .seed-customer-<slug>.sql
--
-- Or run via the interactive runbook (recommended):
--   npm run onboard-customer
--
-- This script is IDEMPOTENT — safe to re-run on partial seeds.

-- ============================================================
-- PLACEHOLDERS (replace before running)
-- ============================================================
--   $CLERK_ORG_ID       e.g. 'org_2xK9aB7cD8...' (from Clerk Dashboard → org → ID)
--   $CUSTOMER_NAME      e.g. 'Acme Corp'         (display name)
--   $CUSTOMER_SLUG      e.g. 'acme-corp'         (lowercase URL-safe)
--   $OWNER_CLERK_ID     e.g. 'user_2yL8mN6oP7...' (Clerk user ID of the workspace owner)
--   $OPERATOR_CLERK_ID  e.g. 'user_2zM9nO5pQ8...' (Clerk user ID of the day-to-day operator)
--   $PROJECT_NAME       e.g. 'Q3 Operations Launch'
--   $PROJECT_ID         e.g. 'proj_c1_001'       (any unique string up to 128 chars)

BEGIN;

-- 1. Workspace (1:1 with Clerk org)
INSERT INTO workspaces (id, name, owner_user_id, slug)
VALUES ('$CLERK_ORG_ID', '$CUSTOMER_NAME', '$OWNER_CLERK_ID', '$CUSTOMER_SLUG')
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      updated_at = now();

-- 2. R40 · users table (must exist as 'approved' for product access)
--    The owner is pre-approved automatically since admin is creating this seed.
INSERT INTO users (id, status, approved_at, approved_by)
VALUES ('$OWNER_CLERK_ID', 'approved', now(), '$OWNER_CLERK_ID')
ON CONFLICT (id) DO UPDATE
  SET status = 'approved',
      approved_at = COALESCE(users.approved_at, EXCLUDED.approved_at),
      approved_by = COALESCE(users.approved_by, EXCLUDED.approved_by),
      updated_at = now();

INSERT INTO users (id, status, approved_at, approved_by)
VALUES ('$OPERATOR_CLERK_ID', 'approved', now(), '$OWNER_CLERK_ID')
ON CONFLICT (id) DO UPDATE
  SET status = 'approved',
      approved_at = COALESCE(users.approved_at, EXCLUDED.approved_at),
      approved_by = COALESCE(users.approved_by, EXCLUDED.approved_by),
      updated_at = now();

-- 3. Owner workspace member (status=active per R40)
INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at, activated_by)
VALUES ('$CLERK_ORG_ID', '$OWNER_CLERK_ID', 'owner', 'active', now(), '$OWNER_CLERK_ID')
ON CONFLICT (workspace_id, user_id) DO UPDATE
  SET role = EXCLUDED.role,
      status = 'active',
      activated_at = COALESCE(workspace_members.activated_at, EXCLUDED.activated_at),
      activated_by = COALESCE(workspace_members.activated_by, EXCLUDED.activated_by);

-- 4. Operator workspace member (status=active; skip if same id as owner)
INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at, activated_by)
VALUES ('$CLERK_ORG_ID', '$OPERATOR_CLERK_ID', 'operator', 'active', now(), '$OWNER_CLERK_ID')
ON CONFLICT (workspace_id, user_id) DO UPDATE
  SET role = EXCLUDED.role,
      status = 'active',
      activated_at = COALESCE(workspace_members.activated_at, EXCLUDED.activated_at),
      activated_by = COALESCE(workspace_members.activated_by, EXCLUDED.activated_by);

-- 5. R40 · audit log entries for the seed operation
INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
VALUES
  ('$OWNER_CLERK_ID', 'workspace_create', 'workspace', '$CLERK_ORG_ID', '$CLERK_ORG_ID', 'onboard-customer seed'),
  ('$OWNER_CLERK_ID', 'user_approve', 'user', '$OWNER_CLERK_ID', '$CLERK_ORG_ID', 'onboard-customer seed · owner'),
  ('$OWNER_CLERK_ID', 'user_approve', 'user', '$OPERATOR_CLERK_ID', '$CLERK_ORG_ID', 'onboard-customer seed · operator'),
  ('$OWNER_CLERK_ID', 'member_activate', 'workspace_member', '$OWNER_CLERK_ID', '$CLERK_ORG_ID', 'onboard-customer seed · owner'),
  ('$OWNER_CLERK_ID', 'member_activate', 'workspace_member', '$OPERATOR_CLERK_ID', '$CLERK_ORG_ID', 'onboard-customer seed · operator');

-- 5b. R55 Phase 4b · operator authority (operator side of the connector + team-invite gate).
-- Provisioning this workspace IS the operator's manual approval (DR-11). The customer still acks
-- consent in-app (POST /api/v1/customer/authority-consent) before connectors/invites unlock.
INSERT INTO customer_authority_consents (
  id, workspace_id, operator_approved_at, operator_approved_by
)
VALUES (
  'auth_' || replace(gen_random_uuid()::text, '-', ''),
  '$CLERK_ORG_ID', now(), '$OPERATOR_CLERK_ID'
)
ON CONFLICT (workspace_id) WHERE revoked_at IS NULL DO UPDATE SET
  operator_approved_at = now(),
  operator_approved_by = EXCLUDED.operator_approved_by,
  updated_at = now();

-- 6. Initial project
INSERT INTO projects (id, workspace_id, name, status)
VALUES ('$PROJECT_ID', '$CLERK_ORG_ID', '$PROJECT_NAME', 'active')
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      status = EXCLUDED.status,
      updated_at = now();

-- 5. Welcome event (gives the customer something to see on first login)
INSERT INTO operation_events (
  id, workspace_id, project_id, source_tool, status, summary, body,
  visibility, occurred_at
)
VALUES (
  'evt_welcome_' || '$CUSTOMER_SLUG',
  '$CLERK_ORG_ID',
  '$PROJECT_ID',
  'operator',
  'completed',
  'Workspace provisioned · welcome to Xlooop',
  'Your Xlooop workspace is live. Events from your operations will stream here automatically.',
  'internal_workspace',
  now()
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ============================================================
-- VERIFICATION (run after seed completes)
-- ============================================================

-- Confirm workspace + member + project + event all exist:
-- SELECT 'workspace' AS table_name, COUNT(*) FROM workspaces WHERE id = '$CLERK_ORG_ID'
-- UNION ALL SELECT 'members', COUNT(*) FROM workspace_members WHERE workspace_id = '$CLERK_ORG_ID'
-- UNION ALL SELECT 'projects', COUNT(*) FROM projects WHERE workspace_id = '$CLERK_ORG_ID'
-- UNION ALL SELECT 'events', COUNT(*) FROM operation_events WHERE workspace_id = '$CLERK_ORG_ID';
--
-- Expected: workspace=1 · members=2 (or 1 if owner==operator) · projects=1 · events=1
