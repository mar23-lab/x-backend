-- 035_template_policy_registry.sql · customer-safe template/policy projection registry
--
-- Authority: Xlooop commercial backend governance plan.
--
-- Intent:
--   * MB-P Git and xcp-platform template packages remain private governance/development
--     authorities.
--   * The customer backend stores only approved, sanitized, redacted operational
--     projections with source refs, content hashes, approvals, rollback pointers,
--     tenant bindings, user overlays, policy decisions, evidence refs, and audit
--     receipts.
--   * Customer APIs must resolve effective templates through tenant-scoped bindings;
--     they must never expose raw MB-P paths, private graph schema, governance
--     scoring templates, secrets, or broad memory-search surfaces.
--   * raw_governance_files_exposed_to_customer_api=false by construction.

-- ============================================================
-- GLOBAL SANITIZED TEMPLATE/POLICY CATALOG
-- ============================================================

CREATE TABLE IF NOT EXISTS template_definitions (
  id                  TEXT PRIMARY KEY,
  template_key        TEXT NOT NULL UNIQUE CHECK (char_length(template_key) <= 160),
  name                TEXT NOT NULL CHECK (char_length(name) <= 160),
  description         TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  category            TEXT NOT NULL CHECK (char_length(category) <= 80),
  source_package      TEXT NOT NULL CHECK (source_package IN ('xcp-platform-templates', 'approved-mbp-projection', 'customer-safe-pack')),
  source_ref          TEXT NOT NULL CHECK (char_length(source_ref) <= 512),
  authority_level     TEXT NOT NULL DEFAULT 'advisory_projection'
                        CHECK (authority_level IN ('platform_default', 'approved_projection', 'advisory_projection')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_template_definitions_category
  ON template_definitions(category, template_key);

CREATE TABLE IF NOT EXISTS template_versions (
  id                  TEXT PRIMARY KEY,
  template_id         TEXT NOT NULL REFERENCES template_definitions(id) ON DELETE CASCADE,
  version             TEXT NOT NULL CHECK (char_length(version) <= 80),
  content_sha256      TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  redacted_content    JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_ref          TEXT NOT NULL CHECK (char_length(source_ref) <= 512),
  source_sha          TEXT NOT NULL CHECK (char_length(source_sha) <= 128),
  approval_ref        TEXT NOT NULL CHECK (char_length(approval_ref) <= 240),
  rollback_version_id TEXT REFERENCES template_versions(id) ON DELETE SET NULL,
  lifecycle_state     TEXT NOT NULL DEFAULT 'draft'
                        CHECK (lifecycle_state IN ('draft', 'approved', 'active', 'deprecated', 'archived')),
  effective_scope     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_template_versions_template_state
  ON template_versions(template_id, lifecycle_state, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_definitions (
  id                  TEXT PRIMARY KEY,
  policy_key          TEXT NOT NULL UNIQUE CHECK (char_length(policy_key) <= 160),
  name                TEXT NOT NULL CHECK (char_length(name) <= 160),
  description         TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  policy_kind         TEXT NOT NULL CHECK (policy_kind IN ('security', 'retention', 'approval', 'redaction', 'tenancy', 'tooling')),
  source_ref          TEXT NOT NULL CHECK (char_length(source_ref) <= 512),
  content_sha256      TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  lifecycle_state     TEXT NOT NULL DEFAULT 'draft'
                        CHECK (lifecycle_state IN ('draft', 'approved', 'active', 'deprecated', 'archived')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TENANT-SCOPED BINDINGS, OVERLAYS, DECISIONS, EVIDENCE, AUDIT
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant_template_bindings (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_id         TEXT NOT NULL REFERENCES template_definitions(id) ON DELETE RESTRICT,
  version_id          TEXT NOT NULL REFERENCES template_versions(id) ON DELETE RESTRICT,
  binding_scope       TEXT NOT NULL
                        CHECK (binding_scope IN ('global', 'vertical', 'tenant', 'workspace', 'project')),
  vertical            TEXT,
  project_id          TEXT REFERENCES projects(id) ON DELETE CASCADE,
  lifecycle_state     TEXT NOT NULL DEFAULT 'active'
                        CHECK (lifecycle_state IN ('active', 'paused', 'archived')),
  approved_by         TEXT NOT NULL,
  approval_ref        TEXT NOT NULL CHECK (char_length(approval_ref) <= 240),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_template_bindings_workspace_scope
  ON tenant_template_bindings(workspace_id, binding_scope, lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_template_bindings_template
  ON tenant_template_bindings(workspace_id, template_id, lifecycle_state);

CREATE TABLE IF NOT EXISTS user_template_overlays (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  template_id         TEXT NOT NULL REFERENCES template_definitions(id) ON DELETE CASCADE,
  overlay_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
  lifecycle_state     TEXT NOT NULL DEFAULT 'active'
                        CHECK (lifecycle_state IN ('active', 'paused', 'archived')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, user_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_user_template_overlays_workspace_user
  ON user_template_overlays(workspace_id, user_id, lifecycle_state);

CREATE TABLE IF NOT EXISTS template_evidence_refs (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('template', 'policy', 'approval', 'audit', 'external_source')),
  source_ref          TEXT NOT NULL CHECK (char_length(source_ref) <= 512),
  content_sha256      TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  classification      TEXT NOT NULL CHECK (classification IN ('public_safe', 'tenant_private', 'operator_private', 'platform_private')),
  redaction_status    TEXT NOT NULL CHECK (redaction_status IN ('redacted', 'metadata_only', 'not_required')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_template_evidence_refs_workspace_created
  ON template_evidence_refs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS template_admin_approvals (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  approval_ref         TEXT NOT NULL CHECK (char_length(approval_ref) <= 240),
  actor_user_id        TEXT NOT NULL,
  action               TEXT NOT NULL CHECK (char_length(action) <= 160),
  status               TEXT NOT NULL DEFAULT 'approved'
                         CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  evidence_ref_id      TEXT REFERENCES template_evidence_refs(id) ON DELETE SET NULL,
  rollback_snapshot_id TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at           TIMESTAMPTZ,
  UNIQUE(workspace_id, approval_ref)
);

CREATE INDEX IF NOT EXISTS idx_template_admin_approvals_workspace_created
  ON template_admin_approvals(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_id           TEXT NOT NULL REFERENCES policy_definitions(id) ON DELETE RESTRICT,
  actor_user_id       TEXT NOT NULL,
  decision            TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'require_approval', 'redact', 'quarantine')),
  reason              TEXT NOT NULL CHECK (char_length(reason) <= 1000),
  evidence_ref_id     TEXT REFERENCES template_evidence_refs(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policy_decisions_workspace_policy
  ON policy_decisions(workspace_id, policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS effective_template_snapshots (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_id         TEXT NOT NULL REFERENCES template_definitions(id) ON DELETE CASCADE,
  user_id             TEXT,
  snapshot_hash       TEXT NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  effective_template  JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_version_ids  TEXT[] NOT NULL DEFAULT '{}',
  evidence_ref_ids    TEXT[] NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_effective_template_snapshots_workspace_created
  ON effective_template_snapshots(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_effective_template_snapshots_template_user
  ON effective_template_snapshots(workspace_id, template_id, user_id, created_at DESC);

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE tenant_template_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_template_overlays ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_evidence_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_admin_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE effective_template_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_template_bindings_workspace_policy ON tenant_template_bindings;
CREATE POLICY tenant_template_bindings_workspace_policy ON tenant_template_bindings
  USING (workspace_id = current_setting('xlooop.current_workspace_id', true))
  WITH CHECK (workspace_id = current_setting('xlooop.current_workspace_id', true));

DROP POLICY IF EXISTS user_template_overlays_workspace_policy ON user_template_overlays;
CREATE POLICY user_template_overlays_workspace_policy ON user_template_overlays
  USING (workspace_id = current_setting('xlooop.current_workspace_id', true))
  WITH CHECK (workspace_id = current_setting('xlooop.current_workspace_id', true));

DROP POLICY IF EXISTS template_evidence_refs_workspace_policy ON template_evidence_refs;
CREATE POLICY template_evidence_refs_workspace_policy ON template_evidence_refs
  USING (workspace_id = current_setting('xlooop.current_workspace_id', true))
  WITH CHECK (workspace_id = current_setting('xlooop.current_workspace_id', true));

DROP POLICY IF EXISTS template_admin_approvals_workspace_policy ON template_admin_approvals;
CREATE POLICY template_admin_approvals_workspace_policy ON template_admin_approvals
  USING (workspace_id = current_setting('xlooop.current_workspace_id', true))
  WITH CHECK (workspace_id = current_setting('xlooop.current_workspace_id', true));

DROP POLICY IF EXISTS policy_decisions_workspace_policy ON policy_decisions;
CREATE POLICY policy_decisions_workspace_policy ON policy_decisions
  USING (workspace_id = current_setting('xlooop.current_workspace_id', true))
  WITH CHECK (workspace_id = current_setting('xlooop.current_workspace_id', true));

DROP POLICY IF EXISTS effective_template_snapshots_workspace_policy ON effective_template_snapshots;
CREATE POLICY effective_template_snapshots_workspace_policy ON effective_template_snapshots
  USING (workspace_id = current_setting('xlooop.current_workspace_id', true))
  WITH CHECK (workspace_id = current_setting('xlooop.current_workspace_id', true));

INSERT INTO workers_schema_version (version, description)
VALUES (35, 'customer-safe template/policy registry projection')
ON CONFLICT (version) DO NOTHING;
