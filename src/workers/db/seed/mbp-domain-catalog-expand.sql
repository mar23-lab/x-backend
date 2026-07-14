-- mbp-domain-catalog-expand.sql · R47.1 · 2026-05-28
--
-- Expands the operator's MB-P domain catalog from 3 → 8 first-class areas.
-- Adds: Infrastructure, Claims discipline, Public/private posture,
-- Investor readiness, Security & compliance.
--
-- These are real operator-recognized domains for MB-P (the platform-of-record
-- for governance + intake + claims + public posture + investor diligence +
-- security ops). Each becomes a Project row that the operator can scope
-- workspace events into via R45 scope_binding.
--
-- Substitute $OPERATOR_WORKSPACE_ID and $OPERATOR_USER_ID inline before apply,
-- OR pipe via sed (see header in operator-mbp-projects.sql).

BEGIN;

INSERT INTO projects (id, workspace_id, name, status, description, metadata)
VALUES
  ('proj_mbp_infrastructure', '$OPERATOR_WORKSPACE_ID', 'Infrastructure', 'active',
   'AI infrastructure · control plane · runtime adapters · MCP servers · contract integrity',
   '{"stage":"Build","intents":4,"signoff":1,"health":"on-track"}'::jsonb),
  ('proj_mbp_claims', '$OPERATOR_WORKSPACE_ID', 'Claims discipline', 'active',
   'Public claim safety · evidence integrity · investor-facing claim hygiene',
   '{"stage":"Review","intents":2,"signoff":2,"health":"watch"}'::jsonb),
  ('proj_mbp_posture', '$OPERATOR_WORKSPACE_ID', 'Public/private posture', 'active',
   'Public vs private surface separation · disclosure policy · external visibility audit',
   '{"stage":"Govern","intents":1,"signoff":0,"health":"watch"}'::jsonb),
  ('proj_mbp_investor', '$OPERATOR_WORKSPACE_ID', 'Investor readiness', 'active',
   'Pitch materials · data room · diligence packets · commercial narrative',
   '{"stage":"Review","intents":3,"signoff":1,"health":"on-track"}'::jsonb),
  ('proj_mbp_security', '$OPERATOR_WORKSPACE_ID', 'Security & compliance', 'active',
   'Secret hygiene · auth boundaries · audit logs · breach response runbook',
   '{"stage":"Operate","intents":2,"signoff":1,"health":"on-track"}'::jsonb)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, status = EXCLUDED.status,
      description = EXCLUDED.description, metadata = EXCLUDED.metadata,
      updated_at = now();

UPDATE projects
   SET scope_binding = '{"version":1,"combine":"any","filters":[{"type":"actor_in","values":["claude-session-*","operator"]},{"type":"source_tool_in","values":["claude","operator"]}]}'::jsonb,
       scope_binding_updated_at = now(),
       scope_binding_updated_by = '$OPERATOR_USER_ID',
       updated_at = now()
 WHERE id IN ('proj_mbp_infrastructure','proj_mbp_claims','proj_mbp_security');

INSERT INTO operation_events (id, workspace_id, project_id, source_tool, agent_id, status, summary, body, visibility, occurred_at)
VALUES
  ('evt_seed_011', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_infrastructure', 'claude',
   'claude-session-arch7', 'completed',
   'R44 MCP server stdio transport · 9 tools · agent-sdk verifier passed',
   'Verified live: 17/17 smoke tests + tools/list returns 9.',
   'internal_workspace', now() - INTERVAL '2 hours 30 minutes'),
  ('evt_seed_012', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_claims', 'operator',
   'operator', 'needs_review',
   'R44+R45 wave external claim review · 24 PRs · need investor narrative',
   'Pending: publishable summary that avoids over-claiming until R48 cockpit lands.',
   'internal_owner_only', now() - INTERVAL '35 minutes'),
  ('evt_seed_013', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_security', 'claude',
   'claude-session-secops', 'completed',
   'Neon DB password rotation queued · operator-action handoff',
   'DB URL was shared in chat during R45.4 migration. Rotate at next operator session.',
   'internal_owner_only', now() - INTERVAL '20 minutes'),
  ('evt_seed_014', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_investor', 'operator',
   'operator', 'queued',
   'Investor pitch · current operator dashboard demo (R47 live-DB view)',
   'Preferred demo path: app.xlooop.com/?screen=db-project&project_id=proj_mbp_governance',
   'internal_workspace', now() - INTERVAL '8 minutes'),
  ('evt_seed_015', '$OPERATOR_WORKSPACE_ID', 'proj_mbp_posture', 'operator',
   'operator', 'blocked',
   'Public surface audit · need policy on what to expose vs not',
   'Customer-safe sanitization works at deploy-time. Need a written policy doc.',
   'internal_workspace', now() - INTERVAL '4 hours')
ON CONFLICT (id) DO UPDATE
  SET workspace_id = EXCLUDED.workspace_id, project_id = EXCLUDED.project_id,
      source_tool = EXCLUDED.source_tool, agent_id = EXCLUDED.agent_id,
      status = EXCLUDED.status, summary = EXCLUDED.summary, body = EXCLUDED.body,
      visibility = EXCLUDED.visibility, occurred_at = EXCLUDED.occurred_at;

COMMIT;
