import { describe, expect, it } from 'vitest';
import {
  SAFE_TOOLS,
  XCP_GATEWAY_NAME,
  XCP_GATEWAY_PROFILE,
  customerSessionStartEnvelope,
} from '../routes/mcp-gateway';
import { MCP_READ_TOOLS, MCP_SERVER_INFO } from '../routes/mcp-rpc';

const REQUIRED_FIELDS = [
  'status',
  'single_mcp_gateway',
  'single_mcp_gateway_required',
  'gateway_profile',
  'effect_mode',
  'identity_scope',
  'selected_route',
  'detected_role',
  'entry_skill',
  'role_panel',
  'required_skills',
  'loaded_skills',
  'stop_conditions',
  'evidence_checked',
  'graph_context',
  'policy_decision',
  'audit_lineage',
  'prior_work_digest',
  'prior_work_discovery_executed',
  'identity',
  'context',
  'scoped_tools',
] as const;

const auth = {
  user_id: 'user_customer',
  workspace_id: 'tenant_customer',
  role: 'viewer',
  email: 'customer@example.com',
  scopes: ['read:status'],
} as never;

describe('canonical xcp.session_start/v1 customer profile', () => {
  it('carries the cross-profile required fields and customer-profile const values', () => {
    const envelope = customerSessionStartEnvelope(auth) as Record<string, unknown>;

    for (const field of REQUIRED_FIELDS) expect(envelope).toHaveProperty(field);
    expect(envelope).toMatchObject({
      schema_id: 'xcp.session_start/v1',
      contract: 'xcp.session_start/v1',
      status: 'pass',
      single_mcp_gateway: 'xcp-gateway',
      single_mcp_gateway_required: true,
      gateway_profile: 'customer',
      effect_mode: 'observe',
      identity_scope: {
        actor_type: 'human_user',
        tenant_scope: 'tenant_customer',
        workspace_scope: 'tenant_customer',
        authn_method: 'clerk_jwt',
        subject_ref: 'user_customer',
        scopes: [],
      },
      selected_route: 'not_applicable',
      detected_role: 'not_applicable',
      entry_skill: 'not_applicable',
      role_panel: {
        schema_id: 'xcp.role_panel/v1',
        task_class: 'not_applicable',
        primary_role: 'not_applicable',
        selected_roles: [],
        role_to_skill_map: [],
        missing_required_roles: [],
      },
      required_skills: [],
      loaded_skills: [],
      stop_conditions: [],
      graph_context: { scope: 'tenant_safe', status: 'not_requested', references: [] },
      policy_decision: { decision: 'allow', reason_codes: [] },
      audit_lineage: { lineage_id: null, audit_refs: [] },
      prior_work_digest: null,
      prior_work_discovery_executed: false,
      requires_additional_gateway: false,
    });
    expect(envelope.evidence_checked).toEqual([
      'tenant_identity',
      'workspace_scope',
      'tenant_safe_tool_scope',
    ]);
    expect(JSON.stringify(envelope.evidence_checked)).not.toMatch(/mb-p|governance|\/Users\//i);
    expect(JSON.stringify({
      role_panel: envelope.role_panel,
      graph_context: envelope.graph_context,
      audit_lineage: envelope.audit_lineage,
    })).not.toMatch(/mb-p|governance|\/Users\//i);
  });

  it('exposes one canonical intake and no legacy peer through live tool discovery', () => {
    const safeNames = SAFE_TOOLS.map((tool) => tool.name);
    const rpcNames = MCP_READ_TOOLS.map((tool) => tool.name);
    const liveDiscovery = JSON.stringify({
      gateway: XCP_GATEWAY_NAME,
      profile: XCP_GATEWAY_PROFILE,
      server: MCP_SERVER_INFO,
      safeNames,
      rpcNames,
    });

    expect(safeNames.filter((name) => name === 'xcp_session_start')).toHaveLength(1);
    expect(rpcNames.filter((name) => name === 'xcp_session_start')).toHaveLength(1);
    expect(liveDiscovery).not.toContain('xlooop.whoami');
    expect(liveDiscovery).not.toContain('xlooop-customer-gateway');
    expect(liveDiscovery).not.toContain('mb-p-gateway');
  });
});
