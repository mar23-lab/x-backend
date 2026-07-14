-- 036_customer_learning_personalization.sql · tenant/user learning personalization
--
-- Intent:
--   * Capture user-level learning signals and personal preferences without
--     weakening tenant security, redaction, retention, approvals, evidence, RCA,
--     tool permissions, or forbidden surfaces.
--   * Let companies promote useful patterns from users to tenant-level defaults
--     only through explicit approval/evidence.
--   * Keep external agents/API/MCP scoped to effective profiles and suggestions;
--     no raw graph, broad memory, secrets, or silent company-wide learning.

CREATE TABLE IF NOT EXISTS user_personalization_profiles (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL,
  role_key              TEXT NOT NULL DEFAULT 'member' CHECK (char_length(role_key) <= 120),
  preference_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  personal_rules_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  personal_skills_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  learned_defaults_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_signal_ids     TEXT[] NOT NULL DEFAULT '{}',
  lifecycle_state       TEXT NOT NULL DEFAULT 'active'
                          CHECK (lifecycle_state IN ('active', 'paused', 'archived')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, user_id, role_key)
);

CREATE INDEX IF NOT EXISTS idx_user_personalization_profiles_workspace_user
  ON user_personalization_profiles(workspace_id, user_id, role_key, lifecycle_state);

CREATE TABLE IF NOT EXISTS user_learning_signals (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  signal_kind         TEXT NOT NULL
                        CHECK (signal_kind IN ('preference', 'personal_rule', 'personal_skill', 'workflow_default', 'correction', 'tool_usage', 'role_fit')),
  source_kind         TEXT NOT NULL
                        CHECK (source_kind IN ('explicit_user_action', 'agent_observation', 'tool_event', 'evidence_feedback', 'approval_feedback', 'onboarding')),
  signal_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  classification      TEXT NOT NULL DEFAULT 'user_private'
                        CHECK (classification IN ('user_private', 'tenant_share_candidate', 'tenant_shared', 'platform_private')),
  promotion_state     TEXT NOT NULL DEFAULT 'private'
                        CHECK (promotion_state IN ('private', 'candidate', 'approved_shared', 'rejected', 'archived')),
  consent_ref         TEXT,
  evidence_ref_id     TEXT REFERENCES template_evidence_refs(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_learning_signals_workspace_user
  ON user_learning_signals(workspace_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_learning_signals_promotion
  ON user_learning_signals(workspace_id, promotion_state, classification, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_learning_profiles (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_key           TEXT NOT NULL CHECK (char_length(profile_key) <= 160),
  role_key              TEXT NOT NULL DEFAULT 'all' CHECK (char_length(role_key) <= 120),
  shared_rules_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  shared_skills_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  shared_defaults_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_signal_ids     TEXT[] NOT NULL DEFAULT '{}',
  approval_ref          TEXT NOT NULL CHECK (char_length(approval_ref) <= 240),
  lifecycle_state       TEXT NOT NULL DEFAULT 'active'
                          CHECK (lifecycle_state IN ('active', 'paused', 'archived')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, profile_key, role_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_learning_profiles_workspace_role
  ON tenant_learning_profiles(workspace_id, role_key, lifecycle_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_learning_promotions (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_user_id        TEXT NOT NULL,
  promoted_by_user_id   TEXT NOT NULL,
  signal_id             TEXT NOT NULL REFERENCES user_learning_signals(id) ON DELETE RESTRICT,
  target_profile_key    TEXT NOT NULL CHECK (char_length(target_profile_key) <= 160),
  promotion_payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  approval_ref          TEXT NOT NULL CHECK (char_length(approval_ref) <= 240),
  evidence_ref_id       TEXT REFERENCES template_evidence_refs(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tenant_learning_promotions_workspace_status
  ON tenant_learning_promotions(workspace_id, status, created_at DESC);

ALTER TABLE user_personalization_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_learning_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_learning_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_learning_promotions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_personalization_profiles_workspace_policy ON user_personalization_profiles;
CREATE POLICY user_personalization_profiles_workspace_policy ON user_personalization_profiles
  USING (workspace_id = current_setting('xlooop.current_workspace_id', true))
  WITH CHECK (workspace_id = current_setting('xlooop.current_workspace_id', true));

DROP POLICY IF EXISTS user_learning_signals_workspace_policy ON user_learning_signals;
CREATE POLICY user_learning_signals_workspace_policy ON user_learning_signals
  USING (workspace_id = current_setting('xlooop.current_workspace_id', true))
  WITH CHECK (workspace_id = current_setting('xlooop.current_workspace_id', true));

DROP POLICY IF EXISTS tenant_learning_profiles_workspace_policy ON tenant_learning_profiles;
CREATE POLICY tenant_learning_profiles_workspace_policy ON tenant_learning_profiles
  USING (workspace_id = current_setting('xlooop.current_workspace_id', true))
  WITH CHECK (workspace_id = current_setting('xlooop.current_workspace_id', true));

DROP POLICY IF EXISTS tenant_learning_promotions_workspace_policy ON tenant_learning_promotions;
CREATE POLICY tenant_learning_promotions_workspace_policy ON tenant_learning_promotions
  USING (workspace_id = current_setting('xlooop.current_workspace_id', true))
  WITH CHECK (workspace_id = current_setting('xlooop.current_workspace_id', true));

INSERT INTO workers_schema_version (version, description)
VALUES (36, 'customer/user learning personalization registry')
ON CONFLICT (version) DO NOTHING;
