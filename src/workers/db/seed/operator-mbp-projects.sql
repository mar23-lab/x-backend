-- operator-mbp-projects.sql · R45.4/R45.5 · 2026-05-28
--
-- One-shot seed that creates real DB rows backing the 3 MB-P fixture
-- projects + a handful of test events under the operator's workspace.
-- This proves R44 MCP + R45 scope_binding work end-to-end against
-- actual DB state (not just static fixtures).
--
-- R45.5 (2026-05-28): aligned with REAL operation_events schema:
--   - Column is `agent_id` (not `actor`) — the R45 scope filter API
--     keeps the name `actor_in` for clarity but maps to agent_id at SQL.
--   - source_tool CHECK constraint: codex | claude | harness | mbp | xlooop | operator
--   - status CHECK constraint: queued | running | blocked | needs_review |
--     completed | failed | approved | rejected | archived
--   - visibility CHECK constraint: internal_workspace | internal_project |
--     internal_owner_only | public_safe
--
-- Substitutions (replace before psql -f):
--   $OPERATOR_WORKSPACE_ID  e.g. 'org_3EIO8YYcUTtjOQ9d1i7eh8mvBFv'
--   $OPERATOR_USER_ID       e.g. 'user_3EINskyClTUBH6Obs9G46gvnBE4'

BEGIN;

-- 1. Three MB-P projects (mirrors data/ws-projects.json fixture shape)
INSERT INTO projects (id, workspace_id, name, status, description, metadata)
VALUES
  ('proj_mbp_governance', '$OPERATOR_WORKSPACE_ID', 'MB-P governance', 'active',
   'Governance domain · gates · sign-off cadence · risk ledger',
   '{"stage":"Operate","intents":3,"signoff":1,"health":"on-track"}'::jsonb),
  ('proj_mbp_intake',     '$OPERATOR_WORKSPACE_ID', 'Unified intake',  'active',
   'Inbound intake routing · classification · workspace tagging',
   '{"stage":"Validate","intents":2,"signoff":0,"health":"on-track"}'::jsonb),
  ('proj_mbp_private',    '$OPERATOR_WORKSPACE_ID', 'Private areas', 'active',
   'Operator-private MB-P sub-domain inventory + boundary review',
   '{"stage":"Validate","intents":1,"signoff":0,"health":"on-track"}'::jsonb)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      status = EXCLUDED.status,
      description = EXCLUDED.description,
      metadata = EXCLUDED.metadata,
      updated_at = now();

-- 2. R45 · scope_binding on MB-P governance · matches claude-session-* + operator
UPDATE projects
   SET scope_binding = '{
         "version": 1,
         "combine": "any",
         "filters": [
           { "type": "actor_in", "values": ["claude-session-*", "operator", "mcp-test"] },
           { "type": "source_tool_in", "values": ["claude", "operator"] }
         ]
       }'::jsonb,
       scope_binding_updated_at = now(),
       scope_binding_updated_by = '$OPERATOR_USER_ID',
       updated_at = now()
 WHERE id = 'proj_mbp_governance';

-- 3. Sample events (10) · mix of agent_ids + statuses + visibilities · adheres to
--    operation_events CHECK constraints (source_tool ∈ allowed set; status likewise).
INSERT INTO operation_events (
  id, workspace_id, project_id, source_tool, agent_id, status, summary, body,
  visibility, occurred_at
)
VALUES
  ('evt_seed_001', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_governance', 'claude',
   'claude-session-abc123', 'completed',
   'R44 MCP server scaffolded · 7 tools wired · 8 smoke tests pass',
   'Full TypeScript stdio MCP server at packages/xlooop-mcp-server.',
   'internal_workspace', now() - INTERVAL '4 hours'),
  ('evt_seed_002', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_governance', 'claude',
   'claude-session-abc123', 'completed',
   'R44.1 verifier-finding closure · input validation · 17/17 tests',
   '2 HIGH + 4 MEDIUM + 3 LOW findings from agent-sdk-verifier closed.',
   'internal_workspace', now() - INTERVAL '3 hours'),
  ('evt_seed_003', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_governance', 'claude',
   'claude-session-def456', 'completed',
   'R45 backend · migration 003 · DAL methods · Worker routes',
   'projects.scope_binding JSONB + 3 DAL methods + 3 routes.',
   'internal_workspace', now() - INTERVAL '2 hours'),
  ('evt_seed_004', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_intake', 'operator',
   'operator', 'running',
   'Customer pilot intake · Honest & Young + ASP',
   'R42 onboarding pack ready. Pending: invite Sid + Dominic to Clerk orgs.',
   'internal_workspace', now() - INTERVAL '90 minutes'),
  ('evt_seed_005', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_governance', 'claude',
   'claude-session-def456', 'completed',
   'R45.2 MCP project tools · project.get + project.set_scope',
   'Operator can now configure scope_binding from Claude Code without leaving chat.',
   'internal_workspace', now() - INTERVAL '60 minutes'),
  ('evt_seed_006', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_governance', 'claude',
   'claude-session-def456', 'completed',
   'R45.3 ProjectScopeBindingPanel widget · self-mounts on project detail',
   'Interactive UI for configuring scope filters. Pure JS, no JSX transform.',
   'internal_workspace', now() - INTERVAL '45 minutes'),
  ('evt_seed_007', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_governance', 'mbp',
   'mcp-test', 'completed',
   'Path A validation event · scope binding filter test',
   'This event has agent_id=mcp-test which matches the scope binding actor_in filter.',
   'internal_workspace', now() - INTERVAL '10 minutes'),
  ('evt_seed_008', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_private', 'operator',
   'operator', 'blocked',
   'Domain hierarchy data shape design · R47',
   'sub-domain catalog needs schema before UI widget can render tree.',
   'internal_workspace', now() - INTERVAL '6 hours'),
  ('evt_seed_009', '$OPERATOR_WORKSPACE_ID', NULL, 'harness',
   'gha-bot', 'completed',
   'CI run · PR #382 R45.3 merged',
   'Workspace-level harness event with no project_id; does NOT match the scope (source_tool=harness not in filter set).',
   'internal_workspace', now() - INTERVAL '40 minutes'),
  ('evt_seed_010', '$OPERATOR_WORKSPACE_ID', NULL, 'xlooop',
   'sid-sharma-honest-young', 'queued',
   'Customer pilot interest · Honest & Young',
   'External customer event · should NOT match the claude-session scope binding.',
   'public_safe', now() - INTERVAL '12 hours')
ON CONFLICT (id) DO UPDATE
  SET workspace_id = EXCLUDED.workspace_id,
      project_id = EXCLUDED.project_id,
      source_tool = EXCLUDED.source_tool,
      agent_id = EXCLUDED.agent_id,
      status = EXCLUDED.status,
      summary = EXCLUDED.summary,
      body = EXCLUDED.body,
      visibility = EXCLUDED.visibility,
      occurred_at = EXCLUDED.occurred_at;

-- 4. Audit log entry omitted: audit_logs.action has a CHECK constraint with a
--    fixed allowlist that doesn't include arbitrary seed identifiers. Operator
--    can attach a post-hoc audit row via admin tooling if needed.

COMMIT;
