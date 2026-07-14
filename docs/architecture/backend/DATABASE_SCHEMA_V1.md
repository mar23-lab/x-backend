# DATABASE_SCHEMA_V1 · Neon Postgres Schema

**Status:** DRAFT — ready for implementation  
**Date:** 2026-05-26  
**Authority:** BACKEND_ADR_001.md stack decision  
**Applies to:** Neon Postgres (Workers-compatible via @neondatabase/serverless HTTP driver)

---

## Design principles

1. **Append-only events** — `operation_events` is an append-only ledger; rows are never deleted, only archived via `archived_at`
2. **Tenant isolation at query layer** — every query includes `WHERE workspace_id = $1` (from JWT); no cross-tenant access is possible at the SQL layer
3. **Relational current-state** — `workspaces`, `projects`, `board_cards`, `sign_offs` are relational; events are the audit trail
4. **NO full CQRS on Day 1** — projection is done at query time with simple JOINs; event sourcing replay is deferred to future scale needs
5. **Postgres-standard DDL** — no Neon-specific syntax; can run on any managed Postgres (Railway, Supabase, self-hosted)
6. **Phase 2 operational spine** — packets, evidence, approvals, tool events, and metric deltas are first-class tenant-scoped rows with RLS-ready policies; they expose safe projections, not raw graph or full memory

---

## Schema DDL

```sql
-- ============================================================
-- TENANTS + IDENTITY
-- ============================================================

CREATE TABLE workspaces (
  id             TEXT PRIMARY KEY,           -- Clerk org ID (e.g. org_2xK...)
  name           TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL,              -- Clerk user ID of the workspace owner
  slug           TEXT UNIQUE,               -- URL-safe name (e.g. "acme-corp")
  config         JSONB DEFAULT '{}',         -- feature flags, branding, etc.
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE workspace_members (
  id            SERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,               -- Clerk user ID
  role          TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer', 'client')),
  invited_by    TEXT,                        -- Clerk user ID of inviter
  joined_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

-- ============================================================
-- PROJECTS
-- ============================================================

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,            -- e.g. "proj_" + nanoid()
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  description   TEXT,
  metadata      JSONB DEFAULT '{}',          -- tags, client_id, phase, etc.
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_projects_workspace ON projects(workspace_id);
CREATE INDEX idx_projects_status ON projects(workspace_id, status);

-- ============================================================
-- OPERATION EVENTS (append-only ledger)
-- Maps 1:1 with R35.HARNESS-FLOW event envelope
-- ============================================================

CREATE TABLE operation_events (
  id              TEXT PRIMARY KEY,           -- event_id from R35.HARNESS-FLOW
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  project_id      TEXT REFERENCES projects(id),
  source_tool     TEXT NOT NULL               -- 'codex' | 'claude' | 'harness' | 'mbp' | 'xlooop' | 'operator'
                    CHECK (source_tool IN ('codex', 'claude', 'harness', 'mbp', 'xlooop', 'operator')),
  agent_id        TEXT,                       -- optional: which agent/runtime emitted
  intent_id       TEXT,                       -- optional: higher-level work item
  status          TEXT NOT NULL
                    CHECK (status IN ('queued', 'running', 'blocked', 'needs_review',
                                      'completed', 'failed', 'approved', 'rejected', 'archived')),
  summary         TEXT NOT NULL,              -- one-line operator-readable description
  body            TEXT,                       -- full event body / detail
  evidence_link   TEXT,                       -- URL or path to proof artefact
  visibility      TEXT NOT NULL DEFAULT 'internal_workspace'
                    CHECK (visibility IN ('internal_workspace', 'internal_project',
                                          'internal_owner_only', 'public_safe')),
  permission_scope TEXT,                      -- per BOUNDARY_MATRIX role identifier
  risk            TEXT,                       -- optional: risk assessment
  approval_state  TEXT CHECK (approval_state IN ('pending', 'approved', 'rejected', NULL)),
  next_action     TEXT,                       -- optional: what operator should do next
  occurred_at     TIMESTAMPTZ NOT NULL,       -- event creation time (from source)
  ingested_at     TIMESTAMPTZ DEFAULT now(),  -- when backend received it
  archived_at     TIMESTAMPTZ                 -- soft-delete / archive
);

CREATE INDEX idx_events_workspace ON operation_events(workspace_id, occurred_at DESC);
CREATE INDEX idx_events_project ON operation_events(project_id, occurred_at DESC);
CREATE INDEX idx_events_status ON operation_events(workspace_id, status);
CREATE INDEX idx_events_visibility ON operation_events(workspace_id, visibility);
-- Partial index for active events (most queries)
CREATE INDEX idx_events_active ON operation_events(workspace_id, occurred_at DESC)
  WHERE archived_at IS NULL;

-- ============================================================
-- BOARD CARDS
-- ============================================================

CREATE TABLE board_cards (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'in_progress', 'blocked', 'review', 'done', 'archived')),
  lane          TEXT,                         -- board lane / column name
  assignee_id   TEXT,                         -- Clerk user ID
  event_id      TEXT REFERENCES operation_events(id),  -- linking card to originating event
  evidence_link TEXT,
  position      INTEGER DEFAULT 0,            -- ordering within lane
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_board_cards_project ON board_cards(project_id, lane, position);
CREATE INDEX idx_board_cards_workspace ON board_cards(workspace_id);

-- ============================================================
-- SIGN-OFFS
-- ============================================================

CREATE TABLE sign_offs (
  id            SERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  event_id      TEXT NOT NULL REFERENCES operation_events(id),
  user_id       TEXT NOT NULL,                -- Clerk user ID of signer
  verdict       TEXT NOT NULL CHECK (verdict IN ('approved', 'rejected', 'noted')),
  comment       TEXT,
  signed_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_sign_offs_event ON sign_offs(event_id);
CREATE INDEX idx_sign_offs_workspace ON sign_offs(workspace_id, signed_at DESC);

-- ============================================================
-- SESSIONS (for analytics / audit trail · not auth sessions)
-- ============================================================

CREATE TABLE operator_sessions (
  id            TEXT PRIMARY KEY,             -- Clerk session ID
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  user_id       TEXT NOT NULL,
  started_at    TIMESTAMPTZ DEFAULT now(),
  last_active   TIMESTAMPTZ DEFAULT now(),
  user_agent    TEXT,
  ip_address    TEXT
);

CREATE INDEX idx_sessions_workspace ON operator_sessions(workspace_id, last_active DESC);

-- ============================================================
-- OPERATIONAL SPINE (Phase 2)
-- Safe packets/events/evidence/approval projection for agents,
-- MCP tools, and external customer workflows.
-- Implemented by migration 034_operational_spine_rls_phase2.sql.
-- ============================================================

CREATE TABLE task_packets (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES projects(id),
  event_id          TEXT REFERENCES operation_events(id),
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  lifecycle_state   TEXT NOT NULL DEFAULT 'draft'
                      CHECK (lifecycle_state IN ('draft', 'ready', 'in_progress',
                                                'evidence_ready', 'approval_requested',
                                                'approved', 'rejected', 'completed',
                                                'archived')),
  actor_user_id     TEXT NOT NULL,
  allowed_tools     TEXT[] NOT NULL DEFAULT '{}',
  forbidden_tools   TEXT[] NOT NULL DEFAULT ARRAY[
                      'raw_graph_export',
                      'full_tenant_memory_export',
                      'internal_template_export',
                      'governance_scoring_export',
                      'agent_routing_export',
                      'private_graph_schema_export',
                      'secret_access',
                      'search_all_memory'
                    ],
  source_refs       TEXT[] NOT NULL DEFAULT '{}',
  evidence_ref_ids  TEXT[] NOT NULL DEFAULT '{}',
  approval_required BOOLEAN NOT NULL DEFAULT true,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE evidence_items (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  packet_id        TEXT REFERENCES task_packets(id) ON DELETE SET NULL,
  event_id         TEXT REFERENCES operation_events(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL
                    CHECK (kind IN ('document', 'screenshot', 'log', 'link',
                                    'commit', 'metric', 'receipt')),
  title            TEXT NOT NULL,
  uri              TEXT NOT NULL,
  content_hash     TEXT,
  summary          TEXT,
  redaction_status TEXT NOT NULL DEFAULT 'metadata_only'
                    CHECK (redaction_status IN ('redacted', 'metadata_only',
                                                'not_required')),
  actor_user_id    TEXT NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE approval_requests (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  packet_id      TEXT REFERENCES task_packets(id) ON DELETE SET NULL,
  event_id       TEXT REFERENCES operation_events(id) ON DELETE SET NULL,
  requested_by   TEXT NOT NULL,
  decided_by     TEXT,
  status         TEXT NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  reason         TEXT NOT NULL,
  decision_comment TEXT,
  requested_at   TIMESTAMPTZ DEFAULT now(),
  decided_at     TIMESTAMPTZ
);

CREATE TABLE tool_events (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  packet_id      TEXT REFERENCES task_packets(id) ON DELETE SET NULL,
  tool_name      TEXT NOT NULL,
  action         TEXT NOT NULL,
  actor_user_id  TEXT NOT NULL,
  status         TEXT NOT NULL
                  CHECK (status IN ('allowed', 'denied', 'completed', 'failed')),
  evidence_item_id TEXT REFERENCES evidence_items(id) ON DELETE SET NULL,
  summary        TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE metric_deltas (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  packet_id         TEXT REFERENCES task_packets(id) ON DELETE SET NULL,
  metric_id         TEXT NOT NULL,
  before_value      NUMERIC,
  after_value       NUMERIC,
  delta_value       NUMERIC,
  evidence_item_id  TEXT REFERENCES evidence_items(id) ON DELETE SET NULL,
  recorded_by       TEXT NOT NULL,
  recorded_at       TIMESTAMPTZ DEFAULT now()
);

-- Phase 2 adds RLS-ready policies:
--   workspace_id = current_setting('xlooop.current_workspace_id', true)
-- plus same-workspace relationship triggers so packets, evidence, events,
-- approvals, tool events, and metric deltas cannot cross tenant boundaries.
-- Live FORCE ROW LEVEL SECURITY is deferred until the Workers request path
-- sets the workspace session variable for every DB transaction.
```

---

## Migration runbook (Neon branching workflow)

```bash
# 1. Create a dev branch in Neon
neon branches create --name "schema-v1-init" --project-id <your-neon-project-id>

# 2. Run schema on dev branch
psql $NEON_DEV_BRANCH_URL -f docs/architecture/backend/DATABASE_SCHEMA_V1.md
# (or use a migration tool like Drizzle / Flyway / raw psql)

# 3. Test against dev branch with integration tests

# 4. Promote to production (merge branch)
neon branches merge --id <branch-id>
```

### Seed data for customer onboarding

```sql
-- Customer 1 workspace (maps to Clerk org)
INSERT INTO workspaces (id, name, owner_user_id, slug)
VALUES ('org_<clerk-org-id>', 'Customer 1 Corp', 'user_<owner-clerk-id>', 'customer-1');

-- Customer 1 operator user
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('org_<clerk-org-id>', 'user_<operator-clerk-id>', 'operator');

-- Initial project
INSERT INTO projects (id, workspace_id, name)
VALUES ('proj_c1_001', 'org_<clerk-org-id>', 'Q3 Operations Launch');
```

---

## Data volume estimates (4 customers · 6 months)

| Table | Estimated rows | Growth rate |
|---|---|---|
| workspaces | 4 | Static at launch |
| workspace_members | ~20 | ~5 per workspace |
| projects | ~20 | ~5 per workspace |
| operation_events | ~10,000/mo | ~2,500/customer/mo |
| board_cards | ~500 | Low churn |
| sign_offs | ~200/mo | Per-event operator actions |
| operator_sessions | ~2,000/mo | Per login |
| task_packets | ~1,000/mo | Agent/customer execution units |
| evidence_items | ~2,000/mo | Evidence callbacks and provider reports |
| approval_requests | ~500/mo | Write/destructive action approvals |
| tool_events | ~5,000/mo | MCP/tool execution reports |
| metric_deltas | ~1,000/mo | Measured readiness/operational deltas |

**Total at 6 months:** ~60,000 rows. Neon free tier (0.5 GB) handles this comfortably.  
**Upgrade to Neon Pro ($19/mo)** at customer 3 or when approaching 500k rows.

---

## Schema evolution rules

1. **Never delete columns** — mark as deprecated in a comment, add `_deprecated_at` marker
2. **Additive migrations only** — new columns with DEFAULT or nullable; no breaking changes
3. **Migration files** in `src/workers/db/migrations/` numbered sequentially: `001_init.sql`, `002_add_risk_field.sql`, etc.
4. **Run migrations on Neon dev branch** — promote after integration test passes
5. **Schema version** tracked in `workers_schema_version` table (added after `001_init.sql`)
6. **RLS rollout discipline** — query-layer tenant scoping stays active at all times; RLS policies may be verified before enforcement, but production `FORCE ROW LEVEL SECURITY` requires a request-scoped DB session variable and live integration proof
