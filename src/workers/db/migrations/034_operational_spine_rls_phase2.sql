-- 034_operational_spine_rls_phase2.sql · backend-first packet/evidence/approval/tool-event spine
--
-- Authority: Xlooop/XCP backend-first architecture; API_CONTRACT_V1 extension.
--
-- Intent:
--   * Customer production backend stores scoped operational projections.
--   * Raw graph, full tenant memory, internal templates, governance scoring,
--     agent routing, private graph schema, secrets, and broad memory search
--     are intentionally NOT represented here.
--   * RLS policies bind every row to xlooop.current_workspace_id when the
--     database role is subject to RLS. Existing DAL methods still carry
--     workspace_id explicitly; request-scoped DB context is the next enforcement
--     step before FORCE ROW LEVEL SECURITY can be made universal.

-- ============================================================
-- TASK PACKETS
-- ============================================================

CREATE TABLE IF NOT EXISTS task_packets (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
  event_id           TEXT REFERENCES operation_events(id) ON DELETE SET NULL,
  title              TEXT NOT NULL CHECK (char_length(title) <= 160),
  summary            TEXT NOT NULL CHECK (char_length(summary) <= 2000),
  lifecycle_state    TEXT NOT NULL DEFAULT 'draft'
                       CHECK (lifecycle_state IN (
                         'draft', 'ready', 'in_progress', 'evidence_ready',
                         'approval_requested', 'approved', 'rejected',
                         'completed', 'archived'
                       )),
  actor_user_id      TEXT NOT NULL,
  allowed_tools      TEXT[] NOT NULL DEFAULT '{}',
  forbidden_tools    TEXT[] NOT NULL DEFAULT ARRAY[
                       'raw_graph_export',
                       'full_tenant_memory_export',
                       'internal_template_export',
                       'governance_scoring_export',
                       'agent_routing_export',
                       'private_graph_schema_export',
                       'secret_access',
                       'search_all_memory'
                     ],
  source_refs        TEXT[] NOT NULL DEFAULT '{}',
  evidence_ref_ids   TEXT[] NOT NULL DEFAULT '{}',
  approval_required  BOOLEAN NOT NULL DEFAULT true,
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_packets_workspace_updated
  ON task_packets(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_packets_project
  ON task_packets(workspace_id, project_id);
CREATE INDEX IF NOT EXISTS idx_task_packets_state
  ON task_packets(workspace_id, lifecycle_state);

-- ============================================================
-- EVIDENCE ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS evidence_items (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  packet_id         TEXT REFERENCES task_packets(id) ON DELETE SET NULL,
  event_id          TEXT REFERENCES operation_events(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL
                      CHECK (kind IN ('document', 'screenshot', 'log', 'link', 'commit', 'metric', 'receipt')),
  title             TEXT NOT NULL CHECK (char_length(title) <= 160),
  uri               TEXT NOT NULL CHECK (char_length(uri) <= 1024),
  content_hash      TEXT,
  summary           TEXT,
  redaction_status  TEXT NOT NULL DEFAULT 'metadata_only'
                      CHECK (redaction_status IN ('redacted', 'metadata_only', 'not_required')),
  actor_user_id     TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_items_workspace_created
  ON evidence_items(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_items_packet
  ON evidence_items(workspace_id, packet_id);

-- ============================================================
-- APPROVAL REQUESTS
-- ============================================================

CREATE TABLE IF NOT EXISTS approval_requests (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  packet_id         TEXT REFERENCES task_packets(id) ON DELETE SET NULL,
  event_id          TEXT REFERENCES operation_events(id) ON DELETE SET NULL,
  requested_by      TEXT NOT NULL,
  decided_by        TEXT,
  status            TEXT NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  reason            TEXT NOT NULL CHECK (char_length(reason) <= 1000),
  decision_comment  TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_workspace_requested
  ON approval_requests(workspace_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_requests_packet
  ON approval_requests(workspace_id, packet_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status
  ON approval_requests(workspace_id, status);

-- ============================================================
-- TOOL EVENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS tool_events (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  packet_id         TEXT REFERENCES task_packets(id) ON DELETE SET NULL,
  tool_name         TEXT NOT NULL CHECK (char_length(tool_name) <= 160),
  action            TEXT NOT NULL
                      CHECK (action IN (
                        'get_task_packet',
                        'get_allowed_scope',
                        'submit_evidence',
                        'report_tool_event',
                        'request_approval',
                        'get_workflow_status',
                        'get_public_policy_summary'
                      )),
  actor_user_id     TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('allowed', 'denied', 'completed', 'failed')),
  evidence_item_id  TEXT REFERENCES evidence_items(id) ON DELETE SET NULL,
  summary           TEXT NOT NULL CHECK (char_length(summary) <= 512),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_events_workspace_created
  ON tool_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_events_packet
  ON tool_events(workspace_id, packet_id);

-- ============================================================
-- METRIC DELTAS
-- ============================================================

CREATE TABLE IF NOT EXISTS metric_deltas (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  packet_id         TEXT REFERENCES task_packets(id) ON DELETE SET NULL,
  metric_id         TEXT NOT NULL CHECK (char_length(metric_id) <= 160),
  before_value      NUMERIC,
  after_value       NUMERIC,
  delta_value       NUMERIC,
  evidence_item_id  TEXT REFERENCES evidence_items(id) ON DELETE SET NULL,
  recorded_by       TEXT NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metric_deltas_workspace_recorded
  ON metric_deltas(workspace_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_metric_deltas_packet
  ON metric_deltas(workspace_id, packet_id);

-- ============================================================
-- SAME-WORKSPACE RELATIONSHIP GUARDS
-- ============================================================

-- Postgres FK constraints cannot express "referenced row has same workspace_id"
-- without composite keys on older tables. The route/DAL already validates this
-- before insert; these trigger checks keep the invariant at the DB boundary too.

CREATE OR REPLACE FUNCTION xlooop_assert_operational_spine_same_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ref_workspace TEXT;
BEGIN
  IF TG_TABLE_NAME = 'evidence_items' AND NEW.packet_id IS NOT NULL THEN
    SELECT workspace_id INTO ref_workspace FROM task_packets WHERE id = NEW.packet_id;
    IF ref_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'packet_id belongs to another workspace';
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('approval_requests', 'tool_events', 'metric_deltas') AND NEW.packet_id IS NOT NULL THEN
    SELECT workspace_id INTO ref_workspace FROM task_packets WHERE id = NEW.packet_id;
    IF ref_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'packet_id belongs to another workspace';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'tool_events' THEN
    IF NEW.evidence_item_id IS NOT NULL THEN
      SELECT workspace_id INTO ref_workspace FROM evidence_items WHERE id = NEW.evidence_item_id;
      IF ref_workspace IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'evidence_item_id belongs to another workspace';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'metric_deltas' THEN
    IF NEW.evidence_item_id IS NOT NULL THEN
      SELECT workspace_id INTO ref_workspace FROM evidence_items WHERE id = NEW.evidence_item_id;
      IF ref_workspace IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'evidence_item_id belongs to another workspace';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evidence_items_same_workspace ON evidence_items;
CREATE TRIGGER trg_evidence_items_same_workspace
BEFORE INSERT OR UPDATE ON evidence_items
FOR EACH ROW EXECUTE FUNCTION xlooop_assert_operational_spine_same_workspace();

DROP TRIGGER IF EXISTS trg_approval_requests_same_workspace ON approval_requests;
CREATE TRIGGER trg_approval_requests_same_workspace
BEFORE INSERT OR UPDATE ON approval_requests
FOR EACH ROW EXECUTE FUNCTION xlooop_assert_operational_spine_same_workspace();

DROP TRIGGER IF EXISTS trg_tool_events_same_workspace ON tool_events;
CREATE TRIGGER trg_tool_events_same_workspace
BEFORE INSERT OR UPDATE ON tool_events
FOR EACH ROW EXECUTE FUNCTION xlooop_assert_operational_spine_same_workspace();

DROP TRIGGER IF EXISTS trg_metric_deltas_same_workspace ON metric_deltas;
CREATE TRIGGER trg_metric_deltas_same_workspace
BEFORE INSERT OR UPDATE ON metric_deltas
FOR EACH ROW EXECUTE FUNCTION xlooop_assert_operational_spine_same_workspace();

-- ============================================================
-- RLS PHASE 2 POLICIES
-- ============================================================

CREATE OR REPLACE FUNCTION xlooop_rls_workspace_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('xlooop.current_workspace_id', true), '')
$$;

ALTER TABLE task_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_deltas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_packets_workspace_policy ON task_packets;
CREATE POLICY task_packets_workspace_policy ON task_packets
  USING (workspace_id = xlooop_rls_workspace_id())
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

DROP POLICY IF EXISTS evidence_items_workspace_policy ON evidence_items;
CREATE POLICY evidence_items_workspace_policy ON evidence_items
  USING (workspace_id = xlooop_rls_workspace_id())
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

DROP POLICY IF EXISTS approval_requests_workspace_policy ON approval_requests;
CREATE POLICY approval_requests_workspace_policy ON approval_requests
  USING (workspace_id = xlooop_rls_workspace_id())
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

DROP POLICY IF EXISTS tool_events_workspace_policy ON tool_events;
CREATE POLICY tool_events_workspace_policy ON tool_events
  USING (workspace_id = xlooop_rls_workspace_id())
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

DROP POLICY IF EXISTS metric_deltas_workspace_policy ON metric_deltas;
CREATE POLICY metric_deltas_workspace_policy ON metric_deltas
  USING (workspace_id = xlooop_rls_workspace_id())
  WITH CHECK (workspace_id = xlooop_rls_workspace_id());

INSERT INTO workers_schema_version (version, description)
VALUES (34, 'Operational spine tables with packet/evidence/approval/tool-event/metric-delta RLS Phase 2 policies')
ON CONFLICT (version) DO NOTHING;
