-- 002_entitlement_gate.sql · Entitlement gate (R40)
--
-- Authority: docs/architecture/backend/AUTH_TENANCY_MODEL.md §Entitlement model
-- Why: Clerk proves identity; this DB layer authorizes product access.
-- A valid Clerk session must NOT automatically grant access.
--
-- Adds:
--   - users               · Neon-side mirror of Clerk users with status gate
--   - access_requests     · public "request to try" funnel (no auth required)
--   - audit_logs          · append-only record of admin actions
--   - workspace_members.status column · per-membership approval flag
--
-- Idempotent: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS everywhere.

-- ============================================================
-- USERS  (Clerk mirror · authoritative entitlement gate)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,              -- Clerk user_id (user_…)
  email           TEXT,                          -- best-effort copy of the Clerk email (for admin display)
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  is_admin        BOOLEAN NOT NULL DEFAULT false, -- Neon-side admin flag (env var ADMIN_USER_IDS also grants)
  approved_at     TIMESTAMPTZ,                   -- when status moved to 'approved'
  approved_by     TEXT,                          -- user_id of admin who approved
  rejection_reason TEXT,
  suspended_at    TIMESTAMPTZ,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),     -- first time backend saw this user
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_admin ON users(is_admin) WHERE is_admin = true;

-- ============================================================
-- WORKSPACE_MEMBERS  (extend with status — per-membership approval)
-- ============================================================

ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'revoked', 'suspended'));

ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS activated_by TEXT;

-- Existing rows seeded before R40 are grandfathered to 'active'
-- (the onboard-customer runbook will set status='active' going forward)
UPDATE workspace_members SET status = 'active', activated_at = COALESCE(activated_at, joined_at)
  WHERE status = 'pending' AND joined_at < '2026-05-26T20:00:00Z';

CREATE INDEX IF NOT EXISTS idx_workspace_members_status
  ON workspace_members(workspace_id, status)
  WHERE status = 'active';

-- ============================================================
-- ACCESS_REQUESTS  (public funnel · no auth required to create)
-- ============================================================

CREATE TABLE IF NOT EXISTS access_requests (
  id              TEXT PRIMARY KEY,              -- req_<nanoid>
  email           TEXT NOT NULL,
  company_name    TEXT,
  reason          TEXT,                          -- free-form "why do you want access"
  source          TEXT,                          -- 'web', 'invite_link', 'manual' etc.
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'invited', 'expired')),
  ip_address      TEXT,                          -- captured at submission, for abuse detection
  user_agent      TEXT,
  user_id         TEXT REFERENCES users(id),     -- linked when associated to a known user
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     TEXT,                          -- admin user_id
  rejection_reason TEXT,
  invited_to_workspace_id TEXT REFERENCES workspaces(id), -- set when admin invites
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_requests_email ON access_requests(email);

-- ============================================================
-- AUDIT_LOGS  (append-only · admin actions only)
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  actor_user_id   TEXT NOT NULL,                 -- admin who performed action
  action          TEXT NOT NULL                  -- 'user_approve', 'user_reject', 'user_suspend',
                                                 -- 'member_activate', 'member_revoke',
                                                 -- 'access_request_approve', 'access_request_reject',
                                                 -- 'workspace_create', 'admin_grant', 'admin_revoke'
                    CHECK (action ~ '^[a-z_]+$'),
  target_type     TEXT NOT NULL                  -- 'user', 'workspace_member', 'access_request', 'workspace'
                    CHECK (target_type IN ('user', 'workspace_member', 'access_request', 'workspace')),
  target_id       TEXT NOT NULL,
  workspace_id    TEXT REFERENCES workspaces(id), -- optional, when action is workspace-scoped
  reason          TEXT,
  metadata        JSONB DEFAULT '{}',
  occurred_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace ON audit_logs(workspace_id, occurred_at DESC)
  WHERE workspace_id IS NOT NULL;

-- ============================================================
-- SCHEMA VERSION
-- ============================================================

INSERT INTO workers_schema_version (version, description)
VALUES (2, 'R40 entitlement gate · users, access_requests, audit_logs, workspace_members.status')
ON CONFLICT (version) DO NOTHING;
