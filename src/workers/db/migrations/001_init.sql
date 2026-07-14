-- 001_init.sql · Initial schema for Xlooop production backend
--
-- Authority: docs/architecture/backend/DATABASE_SCHEMA_V1.md
-- Run on: Neon dev branch first → integration test → promote to main
--
-- Idempotent: uses IF NOT EXISTS for every table/index/column.
-- Safe to re-run on a partially-migrated database.

-- ============================================================
-- TENANTS + IDENTITY
-- ============================================================

CREATE TABLE IF NOT EXISTS workspaces (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL,
  slug           TEXT UNIQUE,
  config         JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id            SERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer', 'client')),
  invited_by    TEXT,
  joined_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

-- ============================================================
-- PROJECTS
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  description   TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(workspace_id, status);

-- ============================================================
-- OPERATION EVENTS (append-only · R35.HARNESS-FLOW envelope)
-- ============================================================

CREATE TABLE IF NOT EXISTS operation_events (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  project_id      TEXT REFERENCES projects(id),
  source_tool     TEXT NOT NULL
                    CHECK (source_tool IN ('codex', 'claude', 'harness', 'mbp', 'xlooop', 'operator')),
  agent_id        TEXT,
  intent_id       TEXT,
  status          TEXT NOT NULL
                    CHECK (status IN ('queued', 'running', 'blocked', 'needs_review',
                                      'completed', 'failed', 'approved', 'rejected', 'archived')),
  summary         TEXT NOT NULL,
  body            TEXT,
  evidence_link   TEXT,
  visibility      TEXT NOT NULL DEFAULT 'internal_workspace'
                    CHECK (visibility IN ('internal_workspace', 'internal_project',
                                          'internal_owner_only', 'public_safe')),
  permission_scope TEXT,
  risk            TEXT,
  approval_state  TEXT CHECK (approval_state IN ('pending', 'approved', 'rejected')),
  next_action     TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL,
  ingested_at     TIMESTAMPTZ DEFAULT now(),
  archived_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_events_workspace ON operation_events(workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_project ON operation_events(project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_status ON operation_events(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_events_visibility ON operation_events(workspace_id, visibility);
CREATE INDEX IF NOT EXISTS idx_events_active ON operation_events(workspace_id, occurred_at DESC)
  WHERE archived_at IS NULL;

-- ============================================================
-- BOARD CARDS
-- ============================================================

CREATE TABLE IF NOT EXISTS board_cards (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'in_progress', 'blocked', 'review', 'done', 'archived')),
  lane          TEXT,
  assignee_id   TEXT,
  event_id      TEXT REFERENCES operation_events(id),
  evidence_link TEXT,
  position      INTEGER DEFAULT 0,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_board_cards_project ON board_cards(project_id, lane, position);
CREATE INDEX IF NOT EXISTS idx_board_cards_workspace ON board_cards(workspace_id);

-- ============================================================
-- SIGN-OFFS
-- ============================================================

CREATE TABLE IF NOT EXISTS sign_offs (
  id            SERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  event_id      TEXT NOT NULL REFERENCES operation_events(id),
  user_id       TEXT NOT NULL,
  verdict       TEXT NOT NULL CHECK (verdict IN ('approved', 'rejected', 'noted')),
  comment       TEXT,
  signed_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_offs_event ON sign_offs(event_id);
CREATE INDEX IF NOT EXISTS idx_sign_offs_workspace ON sign_offs(workspace_id, signed_at DESC);

-- ============================================================
-- OPERATOR SESSIONS (analytics / audit)
-- ============================================================

CREATE TABLE IF NOT EXISTS operator_sessions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  user_id       TEXT NOT NULL,
  started_at    TIMESTAMPTZ DEFAULT now(),
  last_active   TIMESTAMPTZ DEFAULT now(),
  user_agent    TEXT,
  ip_address    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON operator_sessions(workspace_id, last_active DESC);

-- ============================================================
-- SCHEMA VERSION
-- ============================================================

CREATE TABLE IF NOT EXISTS workers_schema_version (
  version       INTEGER PRIMARY KEY,
  applied_at    TIMESTAMPTZ DEFAULT now(),
  description   TEXT NOT NULL
);

INSERT INTO workers_schema_version (version, description)
VALUES (1, 'Initial schema · workspaces, projects, operation_events, board_cards, sign_offs, operator_sessions')
ON CONFLICT (version) DO NOTHING;
