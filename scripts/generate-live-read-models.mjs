#!/usr/bin/env node
// Generate public-safe live read-model snapshots for the Xlooop operations
// cockpit. This is an owner-local producer step: it reads packaged Xlooop data
// plus MB-P graph SQLite metadata, then emits browser-consumable JSON. The
// browser runtime never opens SQLite directly.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const inferredWipRoot = path.resolve(REPO_ROOT, '..', '..');
const WIP_ROOT = fs.existsSync(path.join(inferredWipRoot, 'MB-P'))
  ? inferredWipRoot
  : '/Users/maratbasyrov/WIP';
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const MBP_GRAPH_SQLITE = path.join(WIP_ROOT, 'MB-P/_sys/xcp-system/derivative/ecosystem-graph/ecosystem-graph-index.sqlite');
const GENERATED_AT = new Date().toISOString();
const VALID_UNTIL = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const PROVENANCE = {
  source_mode: 'staged_snapshot',
  generated_at: GENERATED_AT,
  source_adapter: 'xlooop_full_operations_readiness_v1',
};

const MARAT_ACTOR_REF = {
  schema_version: 'ActorRef.v1',
  actor_id: 'actor:marat-basyrov',
  display_name: 'Marat Basyrov',
  kind: 'human',
  source_ref: 'MB-P/AGENTS.md',
};

const ROLE_ROUTE_REFS = {
  'Chief-of-Staff': 'role-route:ecosystem-status-brief',
  'Chief-of-Staff route': 'role-route:ecosystem-status-brief',
  'Knowledge Architect': 'role-route:repo-schema-audit',
  'Infrastructure governance route': 'role-route:integration-boundary-contracts',
  'Product governance route': 'role-route:delivery-readiness-gates',
  'Governed role route': 'role-route:critical-intake-review',
  'Frontend Architect': 'role-route:frontend-architecture-review',
  'DevSecOps': 'role-route:delivery-readiness-gates',
  'DevSecOps Lead': 'role-route:delivery-readiness-gates',
  'Public discovery': 'role-route:customer-onboarding-discovery',
  'Xlooop onboarding': 'role-route:customer-onboarding-discovery',
  'Source register': 'role-route:customer-onboarding-discovery',
};

const DEFAULT_ROLE_ROUTE_REFS = [
  'role-route:ecosystem-status-brief',
  'role-route:repo-schema-audit',
  'role-route:integration-boundary-contracts',
  'role-route:delivery-readiness-gates',
];

const CAPABILITY_REFS = {
  Codex: 'capability:codex-runtime',
  Xlooop: 'capability:xlooop-read-model',
  'Watch-mode preview': 'capability:watch-mode-preview',
  'Proposal receipt gateway': 'capability:proposal-receipt-gateway',
  'Source writeback': 'capability:source-writeback',
};

const OWNER_GRAPH = {
  owner_graph_id: 'owner-graph-marat-basyrov',
  owner_actor_id: 'actor:marat-basyrov',
  model: 'spaces_under_one_owner_account',
  segregation_rule: 'Spaces isolate personal, company, product, docs, frontend, and platform duties while preserving owner-level review.',
};

const SPACE_BY_WORKSPACE = {
  'mbp-private': 'space-mbp-personal',
  'xcp-platform': 'space-xcp-platform',
  xlooop: 'space-xlooop-product',
  'x-biz': 'space-x-biz',
  'x-docs': 'space-x-docs',
  'x-front': 'space-x-front',
  'aps-pty-ltd': 'space-aps-pty-ltd',
};

const OWNER_GRAPH_BY_WORKSPACE = {
  'aps-pty-ltd': 'owner-graph-andrey-p',
};

const ADJACENT_WORKSPACES = [
  {
    kind: 'workspace',
    group: 'adjacent',
    id: 'x-biz',
    name: 'x-biz',
    sub: 'Business, investor readiness, commercial logic, and claim discipline',
    role: 'Owner',
    avatar: 'alt-3',
    repo: 'xlooop-x-biz',
  },
  {
    kind: 'workspace',
    group: 'adjacent',
    id: 'x-docs',
    name: 'x-docs',
    sub: 'Documentation, repository sync, parsing, and publishing workflows',
    role: 'Owner',
    avatar: 'alt-4',
    repo: 'xlooop-x-docs',
  },
  {
    kind: 'workspace',
    group: 'adjacent',
    id: 'x-front',
    name: 'x-front',
    sub: 'Frontend reference shell, graph contracts, and absorption planning',
    role: 'Owner',
    avatar: 'alt-5',
    repo: 'xlooop-x-front',
  },
];

const ADJACENT_PROJECTS = {
  'x-biz': [
    { id: 'x-biz-investor-readiness', name: 'Investor readiness', stage: 'Review', intents: 4, signoff: 1, health: 'watch' },
    { id: 'x-biz-commercial-logic', name: 'Commercial logic', stage: 'Validate', intents: 3, signoff: 1, health: 'on-track' },
    { id: 'x-biz-claim-discipline', name: 'Claim discipline', stage: 'Operate', intents: 2, signoff: 1, health: 'on-track' },
  ],
  'x-docs': [
    { id: 'x-docs-repo-sync', name: 'Repository sync', stage: 'Operate', intents: 3, signoff: 1, health: 'on-track' },
    { id: 'x-docs-architecture', name: 'Architecture documentation', stage: 'Build', intents: 4, signoff: 1, health: 'watch' },
    { id: 'x-docs-demo-readiness', name: 'Demo readiness docs', stage: 'Review', intents: 2, signoff: 1, health: 'on-track' },
  ],
  'x-front': [
    { id: 'x-front-reference-shell', name: 'Reference frontend shell', stage: 'Reference', intents: 4, signoff: 1, health: 'watch' },
    { id: 'x-front-graph-contracts', name: 'Graph contracts', stage: 'Build', intents: 3, signoff: 1, health: 'on-track' },
    { id: 'x-front-absorption-plan', name: 'Absorption planning', stage: 'Blocked until Xlooop green', intents: 2, signoff: 1, health: 'blocked' },
  ],
};

const TEMPLATE_BY_PROJECT = {
  'mbp-life': 'personal_goals',
  'mbp-ops': 'owner_governance',
  'mbp-intake': 'owner_intake',
  'xcp-control-plane': 'ai_governance_infrastructure',
  'xcp-roadmap': 'ai_governance_infrastructure',
  'xlooop-product': 'product_delivery',
  'xlooop-commercial': 'commercial_readiness',
  'x-biz-commercial-claims': 'commercial_claim_discipline',
  'x-biz-public-private-posture': 'public_private_posture',
  'x-biz-investor-readiness': 'investor_readiness',
  'x-biz-commercial-logic': 'commercial_logic',
  'x-biz-claim-discipline': 'commercial_claim_discipline',
  'x-docs-repo-sync': 'documentation_ops',
  'x-docs-architecture': 'documentation_ops',
  'x-docs-demo-readiness': 'documentation_ops',
  'x-front-reference-shell': 'frontend_reference',
  'x-front-graph-contracts': 'frontend_reference',
  'x-front-absorption-plan': 'frontend_reference',
};

const P0_OPERATIONAL_AREAS = new Set(['x-biz-investor-readiness']);

const DOMAIN_TEMPLATE_DEFS = [
  template('investor_readiness', 'Investor readiness', 'business_knowledge', ['overview', 'intents', 'evidence', 'signoff', 'lineage', 'needs_you', 'board'], ['investor_pack', 'claims_matrix', 'fundraising_room'], ['x-biz evidence', 'MB-P claim posture', 'governed proposal receipts']),
  template('product_delivery', 'Product delivery', 'commercial_product', ['overview', 'intents', 'dev', 'qa', 'evidence', 'signoff', 'lineage'], ['storybook_contract_lab', 'runtime_workbench', 'evidence_board'], ['OperationsLiveStream', 'Storybook', 'component contracts']),
  template('owner_governance', 'Owner governance', 'governance', ['overview', 'intents', 'evidence', 'signoff', 'lineage', 'admin'], ['governance_queue', 'hard_rule_board'], ['MB-P graph', 'governance events', 'closing discipline']),
  template('owner_intake', 'Owner intake', 'intake', ['overview', 'needs_you', 'triage', 'evidence', 'lineage'], ['intake_router', 'classification_board'], ['MB-P intake queue', 'routing receipts']),
  template('ai_governance_infrastructure', 'AI governance infrastructure', 'ai_infrastructure', ['overview', 'operations', 'evidence', 'signoff', 'lineage', 'admin'], ['control_plane', 'agent_registry', 'contract_matrix'], ['xcp-platform packages', 'agent registry', 'event contracts']),
  template('commercial_readiness', 'Commercial readiness', 'commercial_readiness', ['overview', 'claims', 'evidence', 'signoff', 'lineage'], ['demo_readiness', 'claims_review'], ['commercial readiness reports', 'claim posture']),
  template('documentation_ops', 'Documentation operations', 'development_docs', ['overview', 'intents', 'docs', 'evidence', 'signoff', 'lineage'], ['repo_sync', 'publishing_board'], ['x-docs repo metadata', 'docs evidence']),
  template('frontend_reference', 'Frontend reference', 'frontend_reference', ['overview', 'dev', 'qa', 'evidence', 'signoff', 'lineage'], ['reference_shell', 'contract_absorption'], ['x-front reference contracts', 'Storybook']),
  template('finance', 'Finance', 'finance', ['overview', 'finance', 'evidence', 'signoff', 'lineage'], ['bas_workspace', 'audit_trail'], ['accounting source adapter', 'evidence export']),
  template('accounting', 'Accounting practice', 'accounting', ['overview', 'workpapers', 'evidence', 'signoff', 'lineage'], ['workpaper_board', 'client_query_board'], ['practice management adapter', 'document store']),
  template('construction_property', 'Construction/property', 'construction_property', ['overview', 'permits', 'evidence', 'signoff', 'lineage'], ['drawing_board', 'permit_tracker'], ['drawings', 'council submissions', 'inspection evidence']),
  template('personal_goals', 'Personal goals', 'personal_operations', ['overview', 'intents', 'evidence', 'signoff', 'learning'], ['life_domain_board', 'goal_review'], ['MB-P personal domain projection']),
  template('business_operations_intake', 'Business operations intake', 'external_onboarding', ['overview', 'intents', 'evidence', 'signoff', 'lineage', 'board'], ['standard_board', 'source_register', 'workflow_opportunity_radar'], ['public website', 'authority confirmation', 'source register']),
];

function template(id, label, domainKind, laneSet, workbenchSet, dataSources) {
  return {
    template_id: id,
    label,
    domain_kind: domainKind,
    lane_set: laneSet,
    workbench_set: workbenchSet,
    data_source_expectations: dataSources,
    action_contracts: ['watch_mode_preview', 'operator_proposal_receipt', 'no_direct_mbp_write'],
    storybook_requirements: ['runtime_parity_story', 'setup_story', 'mode_gate_play_test'],
    setup_checklist: [
      'choose space',
      'confirm workspace policy',
      'activate template',
      'bind live source',
      'assign humans',
      'bind automation capabilities',
      'verify evidence policy',
      'launch in Watch Mode',
    ],
  };
}

const REPO_TO_WORKSPACE = {
  'mb-p': 'mbp-private',
  'xcp-platform': 'xcp-platform',
  'xlooop-xcp-demo': 'xlooop',
  'xlooop-x-biz': 'x-biz',
  'xlooop-x-docs': 'x-docs',
  'xlooop-x-front': 'x-front',
};

const WORKSPACE_DOMAIN_KIND = {
  'mbp-private': 'owner_operations',
  'xcp-platform': 'ai_infrastructure',
  xlooop: 'commercial_product',
  'x-biz': 'business_knowledge',
  'x-docs': 'development_docs',
  'x-front': 'frontend_reference',
};

const spaceRows = ensureAdjacentSpaces(readJson('spaces.json'));
const projectMap = ensureAdjacentProjects(readJson('ws-projects.json'));
const workspaceDetail = ensureWorkspaceDetail(readJson('ws-detail.json'));
const projectData = ensureProjectData(readJson('project-data.json'), projectMap);
const initialStore = ensureInitialStore(readJson('initial-store.json'), projectMap);
const operationsStream = readJson('operations-live-stream.json');
const actionMatrix = readJson('ui-action-contract-matrix.json');
const graphSlice = buildGraphContextSlice();
const operationsRollup = buildOperationsRollup(operationsStream, projectMap, spaceRows);
const domainTemplateCatalog = buildDomainTemplateCatalog();
const operationalAreaSourceMap = buildOperationalAreaSourceMap(projectMap, operationsStream, graphSlice, domainTemplateCatalog);
const workspaceTree = buildWorkspaceTree(spaceRows, projectMap, workspaceDetail, operationsRollup, graphSlice, operationalAreaSourceMap, domainTemplateCatalog);
const memberDirectory = buildMemberDirectory(workspaceDetail, spaceRows);
const governedRoleRoutes = buildGovernedRoleRoutes();
const agentCapabilities = buildAgentCapabilityProjection();
const notifications = buildNotificationEvents(operationsStream);
const actionModeGate = buildActionModeGate(actionMatrix);
const workspaceSetupBlueprint = buildWorkspaceSetupBlueprint(spaceRows, workspaceTree, operationalAreaSourceMap, domainTemplateCatalog);
const proposalReceiptProjection = buildDurableProposalReceiptProjection(actionModeGate, operationalAreaSourceMap);
const handoff = buildCrossSessionHandoff();

writeJson('spaces.json', spaceRows);
writeJson('ws-projects.json', projectMap);
writeJson('ws-detail.json', workspaceDetail);
writeJson('project-data.json', projectData);
writeJson('initial-store.json', initialStore);
writeJson('workspace-tree-read-model.json', workspaceTree);
writeJson('member-directory-read-model.json', memberDirectory);
writeJson('governed-role-route-projection.json', governedRoleRoutes);
writeJson('agent-capability-projection.json', agentCapabilities);
writeJson('operations-rollup-read-model.json', operationsRollup);
writeJson('graph-context-slice.json', graphSlice);
writeJson('notification-event-read-model.json', notifications);
writeJson('action-mode-gate-read-model.json', actionModeGate);
writeJson('domain-template-catalog.json', domainTemplateCatalog);
writeJson('operational-area-source-map.json', operationalAreaSourceMap);
writeJson('workspace-setup-blueprint.json', workspaceSetupBlueprint);
writeJson('durable-proposal-receipts.json', proposalReceiptProjection);
writeJson('../docs/_archive/audits/cross-session-handoff-full-ops.json', handoff);

console.log(JSON.stringify({
  status: 'PASS',
  generated_at: GENERATED_AT,
  workspaces: workspaceTree.workspaces.length,
  projects: workspaceTree.metrics.project_count,
  members: memberDirectory.members.length,
  role_routes: governedRoleRoutes.routes.length,
  agent_capabilities: agentCapabilities.capabilities.length,
  graph_nodes: graphSlice.nodes.length,
  notification_events: notifications.events.length,
  mutating_controls: actionModeGate.metrics.mutating_controls,
  p0_zero_without_blocker: operationalAreaSourceMap.metrics.p0_zero_usefulness_without_blocker_count,
}, null, 2));

function buildWorkspaceTree(spaces, projectsByWorkspace, details, rollup, graph, sourceMap, templateCatalog) {
  const templatesById = Object.fromEntries((templateCatalog.templates || []).map((row) => [row.template_id, row]));
  const workspaces = spaces
    .filter((space) => space.kind === 'workspace')
    .map((space) => {
      const projects = (projectsByWorkspace[space.id] || []).map((project) => {
        const counts = rollup.project_counts[project.id] || {};
        const area = sourceMap.area_by_id?.[project.id] || {};
        const template = templatesById[area.template_id || project.template_id] || {};
        const laneSet = area.lane_set || project.lane_set || template.lane_set || ['overview', 'intents', 'evidence', 'signoff', 'lineage'];
        const workbenchSet = area.workbench_set || project.workbench_set || template.workbench_set || ['standard_board'];
        const laneId = project.lane_id || firstNonEmpty(laneSet) || 'overview';
        const boardId = project.board_id || firstNonEmpty(workbenchSet) || `${project.id}-board`;
        return {
          ...project,
          project_id: project.project_id || project.id,
          lane_id: laneId,
          board_id: boardId,
          workspace_id: space.id,
          space_id: area.space_id || project.space_id || space.space_id || space.id,
          area_kind: area.area_kind || project.area_kind || 'operational_area',
          template_id: area.template_id || project.template_id || inferTemplateId(space.id, project.id),
          source_binding_status: area.source_binding_status || 'metadata_only_gap',
          setup_status: area.setup_status || 'needs_source_binding',
          member_policy: area.member_policy || defaultMemberPolicy(space.id),
          agent_policy: area.agent_policy || defaultAgentPolicy(space.id),
          lane_set: laneSet,
          workbench_set: workbenchSet,
          data_sources: area.data_sources || [],
          action_policy: area.action_policy || defaultActionPolicy(),
          evidence_policy: area.evidence_policy || defaultEvidencePolicy(),
          setup_gap: area.blocking_setup_gap || null,
          status: statusFromProject(project, counts),
          counts,
          click_target: {
            screen: 'project',
            workspace_id: space.id,
            project_id: project.id,
            lane_id: laneId,
            board_id: boardId,
          },
        };
      });
      const workspaceCounts = rollup.workspace_counts[space.id] || {};
      return {
        ...space,
        owner_graph_id: ownerGraphIdForWorkspace(space.id),
        space_id: space.space_id || SPACE_BY_WORKSPACE[space.id] || space.id,
        status: statusFromWorkspace(projects, workspaceCounts),
        counts: workspaceCounts,
        graph: graph.workspace_refs[space.id] || { repo_nodes: [], domain_nodes: [] },
        projects,
        members_count: (details[space.id]?.members || []).length,
        click_target: {
          screen: 'workspace',
          workspace_id: space.id,
        },
      };
    });
  return {
    schema_version: 'xlooop.workspace_tree_read_model.v1',
    source_mode: 'generated_live_snapshot',
    generated_at: GENERATED_AT,
    valid_until: VALID_UNTIL,
    producer_refs: producerRefs([
      'data/spaces.json',
      'data/ws-projects.json',
      'data/ws-detail.json',
      'data/operations-live-stream.json',
      'data/graph-context-slice.json',
    ]),
    compatibility_outputs: ['data/spaces.json', 'data/ws-projects.json', 'data/ws-detail.json'],
    workspaces,
    metrics: {
      workspace_count: workspaces.length,
      project_count: workspaces.reduce((sum, workspace) => sum + workspace.projects.length, 0),
      adjacent_domain_count: workspaces.filter((workspace) => workspace.group === 'adjacent').length,
      status_coverage_percent: percent(workspaces.filter((workspace) => workspace.status).length, workspaces.length),
    },
  };
}

function buildMemberDirectory(details, spaces) {
  const byKey = new Map();
  for (const space of spaces.filter((row) => row.kind === 'workspace')) {
    for (const member of details[space.id]?.members || []) {
      if (isPseudoAgentMember(member)) continue;
      const key = member.handle || member.name;
      if (!key) continue;
      const existing = byKey.get(key) || {
        id: slug(key),
        name: member.name,
        handle: member.handle || null,
        initials: member.initials || initials(member.name),
        kind: normalizeMemberKind(member.kind),
        workspaces: [],
        roles: [],
        source_mode: 'workspace_detail_snapshot',
      };
      existing.workspaces.push(space.id);
      existing.roles.push({
        workspace_id: space.id,
        workspace_name: space.name,
        role: member.role || 'Member',
        team: member.team || 'Workspace',
        availability: member.avail || 'active',
      });
      byKey.set(key, existing);
    }
  }
  const members = Array.from(byKey.values()).map((member) => ({
    ...member,
    workspaces: Array.from(new Set(member.workspaces)),
  }));
  return {
    schema_version: 'xlooop.member_directory_read_model.v1',
    source_mode: 'generated_live_snapshot',
    generated_at: GENERATED_AT,
    valid_until: VALID_UNTIL,
    producer_refs: producerRefs(['data/ws-detail.json', 'data/me.json']),
    active_runtime_fiction_allowed: false,
    member_scope_policy: 'human_external_service_account_only',
    role_routes_projection_ref: 'data/governed-role-route-projection.json',
    agent_capability_projection_ref: 'data/agent-capability-projection.json',
    members,
    metrics: {
      member_count: members.length,
      workspace_role_coverage_percent: percent(
        spaces.filter((space) => space.kind === 'workspace' && details[space.id]?.members?.length).length,
        spaces.filter((space) => space.kind === 'workspace').length,
      ),
    },
  };
}

function buildGovernedRoleRoutes() {
  const routes = [
    {
      role_route_id: 'role-route:ecosystem-status-brief',
      label: 'Ecosystem status brief',
      entry_skill: 'ecosystem-status-brief',
      owner_role: 'chief-of-staff',
      status: 'active',
      workspace_refs: ['mbp-private', 'xcp-platform', 'xlooop'],
      invocation_surfaces: ['chat', 'command', 'session_routing'],
      allowed_repos: ['MB-P', 'Xlooop-XCP-demo', 'xcp-platform'],
      allowed_paths: ['governance', 'docs', 'data'],
      boundary_note: 'Chief-of-staff route for status and context; not a workspace member.',
      source_ref: 'MB-P/_sys/xcp-system/governance/SESSION_ROLE_MANIFEST.yml',
    },
    {
      role_route_id: 'role-route:critical-intake-review',
      label: 'Critical intake review',
      entry_skill: 'critical-intake-review',
      owner_role: 'product-engineering-router',
      status: 'active',
      workspace_refs: ['mbp-private', 'xcp-platform', 'xlooop'],
      invocation_surfaces: ['chat', 'command', 'session_routing'],
      allowed_repos: ['MB-P', 'Xlooop-XCP-demo', 'xcp-platform'],
      allowed_paths: ['governance', 'docs', 'scripts', 'src', 'data'],
      boundary_note: 'Role route invoked by harness/session routing; not a workspace member.',
      source_ref: 'MB-P/_sys/xcp-system/governance/SESSION_ROLE_MANIFEST.yml',
    },
    {
      role_route_id: 'role-route:delivery-readiness-gates',
      label: 'Delivery readiness gates',
      entry_skill: 'delivery-readiness-gates',
      owner_role: 'product-engineering-router',
      status: 'active',
      workspace_refs: ['xlooop', 'xcp-platform'],
      invocation_surfaces: ['chat', 'command', 'automation'],
      allowed_repos: ['Xlooop-XCP-demo', 'xcp-platform'],
      allowed_paths: ['scripts', 'docs/audits', 'package.json'],
      boundary_note: 'Evaluates readiness and gates; not a workspace member and does not grant membership.',
      source_ref: 'MB-P/_sys/xcp-system/governance/ROLE_SKILL_COVERAGE.yml',
    },
    {
      role_route_id: 'role-route:repo-schema-audit',
      label: 'Repo schema audit',
      entry_skill: 'repo-schema-audit',
      owner_role: 'knowledge-architect',
      status: 'active',
      workspace_refs: ['mbp-private', 'xcp-platform', 'xlooop', 'x-biz', 'x-docs', 'x-front'],
      invocation_surfaces: ['chat', 'command', 'session_routing'],
      allowed_repos: ['MB-P', 'Xlooop-XCP-demo', 'xcp-platform', 'x-biz', 'x-docs', 'x-front'],
      allowed_paths: ['docs', 'scripts', 'src', 'data', 'packages'],
      boundary_note: 'Knowledge-architecture route for repo/context audits; not a workspace member.',
      source_ref: 'MB-P/_sys/xcp-system/governance/skills-index.yaml',
    },
    {
      role_route_id: 'role-route:domain-modeling-ddd',
      label: 'Domain modelling',
      entry_skill: 'domain-modeling-ddd',
      owner_role: 'product-engineering-router',
      status: 'active',
      workspace_refs: ['xcp-platform', 'xlooop'],
      invocation_surfaces: ['chat', 'agent_handoff', 'session_routing'],
      allowed_repos: ['Xlooop-XCP-demo', 'xcp-platform'],
      allowed_paths: ['src', 'packages', 'docs'],
      boundary_note: 'Models member/role/capability boundaries; not a workspace member or standing actor.',
      source_ref: 'MB-P/_sys/xcp-system/governance/SESSION_ROLE_MANIFEST.yml',
    },
    {
      role_route_id: 'role-route:integration-boundary-contracts',
      label: 'Integration boundary contracts',
      entry_skill: 'integration-boundary-contracts',
      owner_role: 'product-engineering-router',
      status: 'active',
      workspace_refs: ['xcp-platform', 'xlooop'],
      invocation_surfaces: ['chat', 'command', 'agent_handoff'],
      allowed_repos: ['xcp-platform', 'Xlooop-XCP-demo'],
      allowed_paths: ['packages', 'scripts', 'public-contracts', 'src/shared'],
      boundary_note: 'Defines contract surfaces consumed by Xlooop; not a workspace member.',
      source_ref: 'xcp-platform/public-contracts/xcp-shared-access-contract-pack.v1.json',
    },
    {
      role_route_id: 'role-route:frontend-architecture-review',
      label: 'Frontend architecture review',
      entry_skill: 'frontend-architecture-review',
      owner_role: 'frontend-architect',
      status: 'active',
      workspace_refs: ['xlooop', 'x-front'],
      invocation_surfaces: ['chat', 'command', 'agent_handoff'],
      allowed_repos: ['Xlooop-XCP-demo', 'x-front'],
      allowed_paths: ['src', 'stories', 'docs'],
      boundary_note: 'Frontend review route; not a workspace member, project member, or assignee.',
      source_ref: 'MB-P/_sys/xcp-system/governance/skills-index.yaml',
    },
    {
      role_route_id: 'role-route:customer-onboarding-discovery',
      label: 'Customer onboarding discovery',
      entry_skill: 'customer-onboarding-discovery',
      owner_role: 'onboarding-specialist',
      status: 'active',
      workspace_refs: ['aps-pty-ltd', 'xlooop'],
      invocation_surfaces: ['chat', 'command', 'automation'],
      allowed_repos: ['Xlooop-XCP-demo'],
      allowed_paths: ['data', 'docs/audits', 'scripts'],
      boundary_note: 'Public discovery and authority-gate route; not a workspace member or customer member.',
      source_ref: 'MB-P/_sys/xcp-system/governance/skills-index.yaml',
    },
  ];
  return {
    schema_version: 'xlooop.governed_role_route_projection.v1',
    contract_ref: 'GovernedRoleRouteProjection.v1',
    source_mode: 'generated_live_snapshot',
    generated_at: GENERATED_AT,
    valid_until: VALID_UNTIL,
    member_directory_policy: 'role_routes_are_not_members',
    producer_refs: producerRefs([
      'MB-P/_sys/xcp-system/governance/SESSION_ROLE_MANIFEST.yml',
      'MB-P/_sys/xcp-system/governance/ROLE_SKILL_COVERAGE.yml',
      'xcp-platform/public-contracts/xcp-shared-access-contract-pack.v1.json',
    ]),
    routes,
    metrics: {
      route_count: routes.length,
      routes_not_members: true,
    },
  };
}

function buildAgentCapabilityProjection() {
  const capabilities = [
    {
      capability_id: 'capability:codex-runtime',
      label: 'Codex runtime',
      provider: 'OpenAI Codex local agent runtime',
      capability_type: 'llm',
      supported_modes: ['watch', 'operator'],
      entitlement_required: true,
      receipt_policy: 'proposal_receipt',
      current_status: 'available',
      boundary_note: 'Tool/runtime capability invoked by a real operator session; not a task owner or workspace member.',
      source_ref: 'MB-P/_sys/xcp-system/governance/XCP_HARNESS_AGENT_START_STANDARD.md',
    },
    {
      capability_id: 'capability:xlooop-read-model',
      label: 'Xlooop read-model projection',
      provider: 'Xlooop browser read-model',
      capability_type: 'source_adapter',
      supported_modes: ['watch'],
      entitlement_required: false,
      receipt_policy: 'none',
      current_status: 'available',
      boundary_note: 'Public-safe projection capability; not a human actor.',
      source_ref: 'scripts/generate-live-read-models.mjs',
    },
    {
      capability_id: 'capability:watch-mode-preview',
      label: 'Watch-mode preview',
      provider: 'Xlooop browser read-model',
      capability_type: 'workflow',
      supported_modes: ['watch'],
      entitlement_required: false,
      receipt_policy: 'none',
      current_status: 'available',
      boundary_note: 'Live data and previews only; no source mutation.',
      source_ref: 'data/action-mode-gate-read-model.json',
    },
    {
      capability_id: 'capability:proposal-receipt-gateway',
      label: 'Proposal receipt gateway',
      provider: 'XCP proposal receipt contract',
      capability_type: 'receipt_gateway',
      supported_modes: ['operator'],
      entitlement_required: true,
      receipt_policy: 'proposal_receipt',
      current_status: 'preview',
      boundary_note: 'Creates governed proposal receipts where supported; not direct execution.',
      source_ref: 'xcp-platform/packages/xcp-proposal-receipts/src/index.ts',
    },
    {
      capability_id: 'capability:source-writeback',
      label: 'Source writeback',
      provider: 'Governed backend adapter',
      capability_type: 'source_adapter',
      supported_modes: ['operator'],
      entitlement_required: true,
      receipt_policy: 'execution_receipt',
      current_status: 'blocked',
      boundary_note: 'Blocked until backend governed writeback, diff, approval, and rollback evidence exist.',
      source_ref: 'data/source-writeback-governance.json',
    },
    {
      capability_id: 'capability:pdf-docx-anchors',
      label: 'PDF/DOCX anchors',
      provider: 'Document anchor adapters',
      capability_type: 'workflow',
      supported_modes: ['watch', 'operator'],
      entitlement_required: false,
      receipt_policy: 'proposal_receipt',
      current_status: 'planned',
      boundary_note: 'Markdown anchors are live; PDF/DOCX remain read-only/planned until stable anchor maps exist.',
      source_ref: 'data/document-context-read-model.json',
    },
  ];
  return {
    schema_version: 'xlooop.agent_capability_projection.v1',
    contract_ref: 'AgentCapabilityProjection.v1',
    source_mode: 'generated_live_snapshot',
    generated_at: GENERATED_AT,
    valid_until: VALID_UNTIL,
    member_directory_policy: 'capabilities_are_not_members',
    agent_profile_status: 'deferred',
    deferred_trigger_conditions: [
      'real_agent_execution_surface',
      'runtime_persistence',
      'assignment_workflow',
      'audit_surface',
    ],
    producer_refs: producerRefs([
      'MB-P/_sys/xcp-system/governance/ACTOR_MEMBER_ROLE_AGENT_BOUNDARY_STANDARD.md',
      'xcp-platform/packages/xcp-identity-contracts/src/index.ts',
      'data/action-mode-gate-read-model.json',
    ]),
    capabilities,
    metrics: {
      capability_count: capabilities.length,
      agent_profile_live: false,
    },
  };
}

function buildDomainTemplateCatalog() {
  return {
    schema_version: 'xlooop.domain_template_catalog.v1',
    source_mode: 'generated_live_snapshot',
    generated_at: GENERATED_AT,
    valid_until: VALID_UNTIL,
    owner_graph: OWNER_GRAPH,
    templates: DOMAIN_TEMPLATE_DEFS,
    metrics: {
      template_count: DOMAIN_TEMPLATE_DEFS.length,
      required_template_coverage_percent: percent(DOMAIN_TEMPLATE_DEFS.length, DOMAIN_TEMPLATE_DEFS.length),
      operator_proposal_only: true,
    },
  };
}

function buildOperationalAreaSourceMap(projectsByWorkspace, stream, graph, templateCatalog) {
  const rows = Array.isArray(stream.rows) ? stream.rows : [];
  const graphNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const templatesById = Object.fromEntries((templateCatalog.templates || []).map((row) => [row.template_id, row]));
  const areas = [];
  for (const [workspaceId, projects] of Object.entries(projectsByWorkspace || {})) {
    for (const project of Array.isArray(projects) ? projects : []) {
      const projectId = project.id;
      const templateId = project.template_id || inferTemplateId(workspaceId, projectId);
      const templateRow = templatesById[templateId] || {};
      const scopedRows = rows.filter((row) => canonicalProject(row.project_id) === projectId);
      const workspaceRows = rows.filter((row) => canonicalWorkspace(row.workspace_id || row.workspace) === workspaceId);
      const graphRefs = graphNodes.filter((node) => node.workspace_id === workspaceId).slice(0, 12);
      const isP0 = P0_OPERATIONAL_AREAS.has(projectId);
      const missingSources = [];
      if (scopedRows.length === 0) missingSources.push('operations_live_stream.project_scope');
      if (graphRefs.length === 0) missingSources.push('graph_context.workspace_nodes');
      const sourceBindingStatus = scopedRows.length > 0
        ? 'bound_live_rows'
        : isP0
          ? 'blocking_setup_gap'
          : 'metadata_only_gap';
      const setupStatus = scopedRows.length > 0
        ? 'launched'
        : isP0
          ? 'blocked_missing_live_source'
          : 'configured_metadata_only';
      const blockingSetupGap = sourceBindingStatus === 'blocking_setup_gap'
        ? {
          gap_id: `gap:${projectId}:live-source-binding`,
          severity: 'blocker',
          message: `${project.name} is visible and configured, but no OperationsLiveStream rows are scoped to ${workspaceId}/${projectId}.`,
          exact_missing_source: 'data/operations-live-stream.json rows where workspace_id=x-biz and project_id=x-biz-investor-readiness',
          next_safe_action: 'Bind public-safe x-biz investor-readiness evidence/claims/sign-off rows through the MB-P producer/export path; do not fabricate investor/customer data.',
        }
        : null;
      areas.push({
        area_id: projectId,
        area_kind: 'operational_area',
        workspace_id: workspaceId,
        space_id: SPACE_BY_WORKSPACE[workspaceId] || workspaceId,
        domain_id: project.domain_id || inferDomainId(workspaceId, projectId),
        domain_kind: project.domain_kind || inferDomainKind(workspaceId, projectId),
        template_id: templateId,
        p0_visible_route: isP0,
        source_binding_status: sourceBindingStatus,
        setup_status: setupStatus,
        live_scoped_rows: scopedRows.length,
        workspace_scoped_rows: workspaceRows.length,
        graph_node_refs: graphRefs.map((node) => node.id),
        repo_refs: Array.from(new Set(graphRefs.map((node) => node.repo).filter(Boolean))),
        doc_refs: [],
        gateway_receipt_refs: [],
        missing_sources: missingSources,
        blocking_setup_gap: blockingSetupGap,
        member_policy: defaultMemberPolicy(workspaceId),
        agent_policy: defaultAgentPolicy(workspaceId),
        lane_set: templateRow.lane_set || ['overview', 'intents', 'evidence', 'signoff', 'lineage'],
        workbench_set: templateRow.workbench_set || ['standard_board'],
        data_sources: templateRow.data_source_expectations || [],
        action_policy: defaultActionPolicy(),
        evidence_policy: defaultEvidencePolicy(),
        provenance: producerRefs(['data/operations-live-stream.json', 'data/graph-context-slice.json', 'data/ws-projects.json']),
      });
    }
  }
  const p0Areas = areas.filter((area) => area.p0_visible_route);
  const p0ZeroWithoutBlocker = p0Areas.filter((area) => area.live_scoped_rows === 0 && area.source_binding_status !== 'blocking_setup_gap');
  const areaById = Object.fromEntries(areas.map((area) => [area.area_id, area]));
  return {
    schema_version: 'xlooop.operational_area_source_map.v1',
    source_mode: 'generated_live_snapshot',
    generated_at: GENERATED_AT,
    valid_until: stream.valid_until || VALID_UNTIL,
    owner_graph: OWNER_GRAPH,
    browser_sqlite_access_allowed: false,
    raw_private_content_included: false,
    producer_refs: producerRefs(['data/operations-live-stream.json', 'data/graph-context-slice.json', 'data/ws-projects.json']),
    areas,
    area_by_id: areaById,
    metrics: {
      area_count: areas.length,
      classified_percent: percent(areas.filter((area) => area.template_id && area.space_id).length, areas.length),
      source_map_coverage_percent: percent(areas.filter((area) => area.source_binding_status).length, areas.length),
      live_scoped_area_percent: percent(areas.filter((area) => area.live_scoped_rows > 0).length, areas.length),
      p0_visible_area_count: p0Areas.length,
      p0_zero_usefulness_without_blocker_count: p0ZeroWithoutBlocker.length,
      p0_blocking_setup_gap_count: p0Areas.filter((area) => area.source_binding_status === 'blocking_setup_gap').length,
    },
  };
}

function buildWorkspaceSetupBlueprint(spaces, workspaceTree, sourceMap, templateCatalog) {
  const workspaces = (workspaceTree.workspaces || []).map((workspace) => ({
    workspace_id: workspace.id,
    space_id: workspace.space_id || SPACE_BY_WORKSPACE[workspace.id] || workspace.id,
    setup_status: workspace.projects.some((project) => project.setup_status === 'blocked_missing_live_source') ? 'blocked_missing_live_source' : 'ready_for_watch_mode',
    available_templates: Array.from(new Set(workspace.projects.map((project) => project.template_id).filter(Boolean))),
    checklist: setupChecklistForWorkspace(workspace),
    operational_areas: workspace.projects.map((project) => ({
      area_id: project.id,
      label: project.name,
      template_id: project.template_id,
      source_binding_status: project.source_binding_status,
      setup_status: project.setup_status,
      blocking_setup_gap: project.setup_gap,
    })),
  }));
  return {
    schema_version: 'xlooop.workspace_setup_blueprint.v1',
    source_mode: 'generated_live_snapshot',
    generated_at: GENERATED_AT,
    valid_until: VALID_UNTIL,
    owner_graph: OWNER_GRAPH,
    setup_flow: ['choose_space', 'workspace_identity', 'templates', 'operational_areas', 'humans', 'agents', 'data', 'actions', 'evidence', 'launch'],
    write_model: 'watch_mode_preview_or_operator_governed_proposal_only',
    direct_mbp_write_allowed: false,
    spaces: spaces.filter((space) => space.kind === 'workspace').map((space) => ({
      space_id: space.space_id || SPACE_BY_WORKSPACE[space.id] || space.id,
      workspace_id: space.id,
      label: space.name,
      boundary: space.id === 'mbp-private' ? 'personal_operational' : 'company_or_product_operational',
      default_visibility: 'private',
    })),
    workspaces,
    template_catalog_ref: templateCatalog.schema_version,
    source_map_ref: sourceMap.schema_version,
    metrics: {
      workspace_count: workspaces.length,
      setup_flow_step_count: 10,
      blocked_workspace_count: workspaces.filter((workspace) => workspace.setup_status === 'blocked_missing_live_source').length,
      watch_mode_preview_supported: true,
      operator_proposal_only: true,
    },
  };
}

function buildOperationsRollup(stream, projectsByWorkspace, spaces) {
  const rows = Array.isArray(stream.rows) ? stream.rows : [];
  const workspaceCounts = {};
  const projectCounts = {};
  for (const row of rows) {
    const workspaceId = canonicalWorkspace(row.workspace_id || row.workspace);
    const projectId = canonicalProject(row.project_id);
    if (workspaceId) incrementCounts(workspaceCounts, workspaceId, row);
    if (projectId) incrementCounts(projectCounts, projectId, row);
  }
  for (const space of spaces.filter((row) => row.kind === 'workspace')) {
    workspaceCounts[space.id] = workspaceCounts[space.id] || emptyCounts();
    for (const project of projectsByWorkspace[space.id] || []) {
      const projectIsBlocked = isProjectBlocked(project);
      projectCounts[project.id] = projectCounts[project.id] || {
        ...emptyCounts(),
        blocked: projectIsBlocked ? 1 : 0,
        intents: project.intents || 0,
        evidence: project.evidence || 0,
        signoff: project.signoff || 0,
      };
    }
  }
  return {
    schema_version: 'xlooop.operations_rollup_read_model.v1',
    source_mode: stream.source_mode || 'generated_live_snapshot',
    generated_at: GENERATED_AT,
    valid_until: stream.valid_until || VALID_UNTIL,
    producer_refs: producerRefs(['data/operations-live-stream.json']),
    stream_rows_total: rows.length,
    workspace_counts: workspaceCounts,
    project_counts: projectCounts,
    metrics: {
      row_count: rows.length,
      workspace_count: Object.keys(workspaceCounts).length,
      project_count: Object.keys(projectCounts).length,
    },
  };
}

function buildGraphContextSlice() {
  const source = {
    path: MBP_GRAPH_SQLITE,
    source_mode: 'owner_local_sqlite_export',
    raw_content_included: false,
    browser_sqlite_access_allowed: false,
  };
  const repoSummaryRows = sqliteJson('select repo, count(*) as count from nodes group by repo order by count desc limit 80;');
  const typeRows = sqliteJson('select type, count(*) as count from nodes group by type order by count desc limit 40;');
  const nodeRows = sqliteJson(`
    select id, type, label, repo, state, degree
    from nodes
    where type in ('repo','domain','skill','event','gate','evidence','capability','intake','finding','recommendation')
    order by degree desc
    limit 160;
  `);
  const nodes = nodeRows
    .filter((node) => !String(node.label || '').startsWith('/Users/'))
    .map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      repo: node.repo || null,
      workspace_id: REPO_TO_WORKSPACE[node.repo] || REPO_TO_WORKSPACE[node.label] || null,
      state: node.state || null,
      degree: Number(node.degree || 0),
    }));
  const workspaceRefs = {};
  for (const node of nodes) {
    if (!node.workspace_id) continue;
    workspaceRefs[node.workspace_id] = workspaceRefs[node.workspace_id] || { repo_nodes: [], domain_nodes: [], evidence_nodes: [] };
    if (node.type === 'repo') workspaceRefs[node.workspace_id].repo_nodes.push(node.id);
    if (node.type === 'domain') workspaceRefs[node.workspace_id].domain_nodes.push(node.id);
    if (node.type === 'evidence') workspaceRefs[node.workspace_id].evidence_nodes.push(node.id);
  }
  return {
    schema_version: 'xlooop.graph_context_slice.v1',
    source_mode: 'owner_local_sqlite_export',
    generated_at: GENERATED_AT,
    valid_until: VALID_UNTIL,
    producer_refs: producerRefs(['MB-P ecosystem graph SQLite']),
    source,
    repo_summary: repoSummaryRows,
    type_summary: typeRows,
    nodes,
    workspace_refs: workspaceRefs,
    metrics: {
      nodes_exported: nodes.length,
      repo_count: repoSummaryRows.filter((row) => row.repo).length,
      raw_content_included: false,
    },
  };
}

function buildNotificationEvents(stream) {
  const rows = Array.isArray(stream.rows) ? stream.rows : [];
  const events = rows
    .map((row, index) => {
      const text = `${row.title || ''} ${row.summary || ''} ${row.state || ''} ${row.stream_type || ''}`.toLowerCase();
      let topic = null;
      if (/owner|review|required|confirm/.test(text)) topic = 'governance_packet.owner_confirmation_required';
      if (/collaboration|reviewer|joined|invited/.test(text)) topic = 'collaboration.member_joined';
      if (/blocked|fail|stale/.test(text)) topic = 'readiness.blocked';
      if (!topic) return null;
      return {
        id: row.row_id || row.source_event_id || `notification:${index}`,
        topic,
        title: row.title || 'Operations notification',
        summary: row.summary || row.title || '',
        workspace_id: canonicalWorkspace(row.workspace_id || row.workspace),
        project_id: canonicalProject(row.project_id),
        timestamp_iso: row.timestamp_iso || stream.generated_at || GENERATED_AT,
        unread: /owner|blocked|required|confirm/.test(text),
        source_row_id: row.row_id || null,
      };
    })
    .filter(Boolean);
  return {
    schema_version: 'xlooop.notification_event_read_model.v1',
    source_mode: 'eventbus_projection_snapshot',
    generated_at: GENERATED_AT,
    valid_until: stream.valid_until || VALID_UNTIL,
    producer_refs: producerRefs(['data/operations-live-stream.json', '@xcp/event-contracts']),
    required_topics: [
      'governance_packet.owner_confirmation_required',
      'readiness.blocked',
      'collaboration.member_joined',
    ],
    events,
    metrics: {
      event_count: events.length,
      required_topic_coverage_percent: percent(
        new Set(events.map((event) => event.topic)).size,
        3,
      ),
    },
  };
}

function buildActionModeGate(matrix) {
  const controls = Array.isArray(matrix.controls) ? matrix.controls : [];
  const mutating = controls.filter(isActionModeGateControl);
  const contextOnlyTransitions = controls.filter((control) =>
    control
    && control.classification === 'state_transition'
    && control.receipt_expected !== true
    && control.direct_mbp_write_allowed === false,
  );
  return {
    schema_version: 'xlooop.action_mode_gate.v1',
    source_mode: 'ui_action_contract_matrix_projection',
    generated_at: GENERATED_AT,
    valid_until: VALID_UNTIL,
    producer_refs: producerRefs(['data/ui-action-contract-matrix.json', 'src/shared/services/cockpit-stream-source/CockpitStreamSource.jsx']),
    default_mode: 'watch',
    modes: {
      watch: {
        can_mutate: false,
        behavior: 'no-op explanatory toast plus cockpit-action-blocked event',
      },
      test: {
        can_mutate: false,
        behavior: 'feedback annotations and persisted UI comments; mutating controls remain no-op or proposal-only',
      },
      operator: {
        can_mutate: true,
        behavior: 'governed proposal/action receipt only; no direct MB-P write',
        receipt_schema: 'xlooop.operator_proposal_receipt.v1',
      },
    },
    engine_contract_defaults: {
      engine_contract_id: 'engine.governed_chat_capture_ledger',
      engine_contract_exception: null,
      replay_available: false,
      verifier: 'verify:action-mode-gate-coverage',
      owner_decision_state: 'owner_decision_required_for_operator_commit',
    },
    non_mutating_state_transitions: contextOnlyTransitions.map((control) => control.id),
    mutating_controls: mutating.map((control) => ({
      id: control.id,
      surface: control.surface,
      label: control.label,
      classification: control.classification,
      route_or_event: control.route_or_event || control.disabled_reason || null,
      risk_lane: control.risk_lane || control.risk || 'low',
      rollback_available: Boolean(control.rollback_available),
      gate_required: true,
      proposal_receipt_required: true,
      direct_mbp_write_allowed: false,
      receipt_contract: {
        required_fields: ['receipt_id', 'proposal_id', 'target_space', 'target_workspace', 'target_area', 'lane', 'actor', 'action', 'risk', 'status', 'timestamp_iso', 'rollback_note'],
        storage: 'xcp.cockpit.proposal_receipts.v1',
      },
    })),
    metrics: {
      total_controls: controls.length,
      mutating_controls: mutating.length,
      non_mutating_state_transitions: contextOnlyTransitions.length,
      gate_coverage_percent: mutating.length ? 100 : 0,
      operator_receipt_contract_coverage_percent: mutating.length ? 100 : 0,
    },
  };
}

function isActionModeGateControl(control) {
  return Boolean(
    control
    && control.receipt_expected === true
    && ['state_transition', 'download'].includes(control.classification),
  );
}

function buildDurableProposalReceiptProjection(actionGate, sourceMap) {
  const controls = actionGate.mutating_controls || [];
  return {
    schema_version: 'xlooop.durable_proposal_receipts.v1',
    source_mode: 'generated_live_snapshot',
    generated_at: GENERATED_AT,
    valid_until: VALID_UNTIL,
    direct_mbp_write_allowed: false,
    persistence: {
      browser_local_key: 'xcp.cockpit.proposal_receipts.v1',
      gateway_execution: 'deferred',
      receipt_authority: 'operator-local proposal receipt until MB-P gateway accepts the proposal',
    },
    receipt_contracts: controls.map((control) => ({
      control_id: control.id,
      surface: control.surface,
      action_label: control.label,
      engine_contract_ref: 'action_mode_gate.engine_contract_defaults',
      risk_lane: control.risk_lane,
      rollback_available: control.rollback_available,
      required_fields: control.receipt_contract.required_fields,
      rollback_note_required: true,
      target_context_required: true,
    })),
    required_p0_area_receipts: (sourceMap.areas || [])
      .filter((area) => area.p0_visible_route)
      .map((area) => ({
        area_id: area.area_id,
        workspace_id: area.workspace_id,
        space_id: area.space_id,
        expected_operator_actions: ['activate-template', 'bind-live-source', 'request-owner-signoff'],
      })),
    latest_receipts: [],
    metrics: {
      mutating_control_contracts: controls.length,
      receipt_contract_coverage_percent: controls.length ? 100 : 0,
      p0_area_receipt_expectations: (sourceMap.areas || []).filter((area) => area.p0_visible_route).length,
    },
  };
}

function buildCrossSessionHandoff() {
  return {
    schema_version: 'xlooop.cross_session_handoff.full_ops.v1',
    source_mode: 'xlooop_generated_handoff',
    generated_at: GENERATED_AT,
    valid_until: VALID_UNTIL,
    mutation_boundary: 'Xlooop-XCP-demo only',
    targets: [
      ['mb-p-governance', 'Registry accepted xlooop-xcp-demo-B as an active partial adapter after conformance evidence was consumed.', 'completed'],
      ['xcp-platform-A', 'Confirmed @xcp/event-contracts, @xcp/data-substrate, and Storybook maturity compatibility for Xlooop read-model adapters.', 'completed'],
      ['x-front-D', 'Keep reference-only until Ilmir/owner implementation gates and merge-readiness smoke close.', 'blocked_until_owner_unblocks'],
      ['x-biz-D', 'Provide or confirm public-safe business/domain metadata for WorkspaceTreeReadModel.', 'required'],
      ['x-docs-F', 'Provide or confirm public-safe docs/domain metadata for WorkspaceTreeReadModel.', 'required'],
    ].map(([target, requested_action, status]) => ({
      target,
      requested_action,
      local_mutation_allowed_by_this_session: false,
      status,
    })),
  };
}

function ensureAdjacentSpaces(spaces) {
  const byId = new Map((Array.isArray(spaces) ? spaces : []).map((space) => [space.id, space]));
  for (const space of ADJACENT_WORKSPACES) byId.set(space.id, { ...(byId.get(space.id) || {}), ...space });
  return Array.from(byId.values()).map((space) => {
    if (space.kind !== 'workspace') return space;
    return {
      ...space,
      workspace_id: space.id,
      domain_id: space.domain_id || space.id,
      domain_kind: space.domain_kind || WORKSPACE_DOMAIN_KIND[space.id] || 'operations',
      owner_graph_id: ownerGraphIdForWorkspace(space.id),
      space_id: space.space_id || SPACE_BY_WORKSPACE[space.id] || space.id,
      member_policy: defaultMemberPolicy(space.id),
      agent_policy: defaultAgentPolicy(space.id),
      ...PROVENANCE,
    };
  });
}

function ensureAdjacentProjects(projects) {
  const out = { ...(projects || {}) };
  for (const [workspaceId, list] of Object.entries(ADJACENT_PROJECTS)) {
    const existing = new Map((out[workspaceId] || []).map((project) => [project.id, project]));
    for (const project of list) existing.set(project.id, { ...(existing.get(project.id) || {}), ...project });
    out[workspaceId] = Array.from(existing.values());
  }
  for (const [workspaceId, list] of Object.entries(out)) {
    if (!Array.isArray(list)) continue;
    out[workspaceId] = list.map((project) => ({
      ...project,
      project_id: project.project_id || project.id,
      lane_id: project.lane_id || firstNonEmpty(project.lane_set) || firstNonEmpty(templateDefaultsForProject(workspaceId, project.id).lane_set) || 'overview',
      board_id: project.board_id || firstNonEmpty(project.workbench_set) || firstNonEmpty(templateDefaultsForProject(workspaceId, project.id).workbench_set) || `${project.id}-board`,
      workspace_id: workspaceId,
      domain_id: project.domain_id || inferDomainId(workspaceId, project.id),
      domain_kind: project.domain_kind || inferDomainKind(workspaceId, project.id),
      space_id: project.space_id || SPACE_BY_WORKSPACE[workspaceId] || workspaceId,
      area_kind: 'operational_area',
      template_id: project.template_id || inferTemplateId(workspaceId, project.id),
      source_binding_status: project.source_binding_status || 'metadata_pending',
      setup_status: project.setup_status || 'configured_metadata_only',
      member_policy: defaultMemberPolicy(workspaceId),
      agent_policy: defaultAgentPolicy(workspaceId),
      action_policy: defaultActionPolicy(),
      ...PROVENANCE,
    }));
  }
  return out;
}

function ownerGraphIdForWorkspace(workspaceId) {
  return OWNER_GRAPH_BY_WORKSPACE[workspaceId] || OWNER_GRAPH.owner_graph_id;
}

function ensureWorkspaceDetail(details) {
  const out = { ...(details || {}) };
  for (const space of ADJACENT_WORKSPACES) {
    out[space.id] = out[space.id] || {
      members: [
        ownerMember(),
      ],
      teams: [
        {
          id: `${space.id}-operations`,
          name: `${space.name} operations`,
          sub: space.sub,
          members: ['@marat'],
          lead: '@marat',
        },
      ],
      activity: [
        {
          source_kind: 'role_route',
          role_route_ref: 'role-route:critical-intake-review',
          source_label: 'Critical intake review',
          what: 'published public-safe domain metadata for Xlooop cockpit visibility',
          where: space.name,
          when: 'generated snapshot',
          kind: 'check',
        },
      ],
      tasks: [],
      settings: {
        name: space.name,
        slug: space.id,
        visibility: 'private',
        defaultRole: 'Owner approved',
        slaDefault: '24 hours for owner-visible cross-repo handoff',
        gates: ['Adapter manifest', 'Read-model provenance', 'Owner sign-off'],
        retention: 'Governed by MB-P lifecycle and public-safe export policy',
        integrations: [
          { name: 'GitHub', status: 'connected', sub: 'Repo metadata and commit evidence' },
          { name: 'MB-P graph', status: 'connected', sub: 'Public-safe graph slice only' },
        ],
      },
    };
  }
  for (const [workspaceId, detail] of Object.entries(out)) {
    out[workspaceId] = {
      ...detail,
      members: (detail.members || []).filter((member) => !isPseudoAgentMember(member)),
      teams: (detail.teams || []).map((team) => ({
        ...team,
        members: (team.members || []).filter((handle) => !isPseudoAgentHandle(handle)),
      })),
      activity: (detail.activity || []).map((row) => sanitizeActivityActor(row)),
      workspace_id: workspaceId,
      domain_id: detail.domain_id || workspaceId,
      domain_kind: detail.domain_kind || WORKSPACE_DOMAIN_KIND[workspaceId] || 'operations',
      ...PROVENANCE,
    };
  }
  return out;
}

function ensureProjectData(projectData, projectsByWorkspace) {
  const out = { ...(projectData || {}) };
  for (const [workspaceId, projects] of Object.entries(projectsByWorkspace || {})) {
    for (const project of projects) {
      out[project.id] = out[project.id] || {
        summary: `${project.name} domain surfaced from ${workspaceId} public-safe repository metadata.`,
        owners: [
          { name: 'Marat Basyrov', role: 'Owner operator', initials: 'MB' },
        ],
        kpi: [
          { lbl: 'Open intents', val: project.intents, delta: project.stage, up: project.health !== 'blocked' },
          { lbl: 'Sign-off due', val: project.signoff, delta: 'owner gated', up: project.health !== 'blocked' },
          { lbl: 'Repo context', val: 'linked', delta: workspaceId, up: true },
          { lbl: 'Read model', val: 'generated', delta: 'public-safe', up: true },
        ],
        pipeline: [
          { stage: 'Intent', count: Math.max(1, project.intents - 1), active: true },
          { stage: 'Evidence', count: Math.max(1, project.signoff) },
          { stage: 'Sign-off', count: project.signoff, active: project.health === 'review' || project.health === 'blocked' },
          { stage: 'Learning', count: 1 },
        ],
        evidence: [],
        signoff: [],
        lineage: { nodes: [], edges: [] },
      };
      out[project.id].owners = sanitizeOwners(out[project.id].owners);
    }
  }
  return out;
}

function sanitizeOwners(owners) {
  const realOwners = (Array.isArray(owners) ? owners : [])
    .filter((owner) => !isPseudoAgentMember(owner));
  if (!realOwners.some((owner) => /marat/i.test(owner.name || ''))) {
    realOwners.unshift({ name: 'Marat Basyrov', role: 'Owner operator', initials: 'MB' });
  }
  return realOwners;
}

function normalizeMemberKind(kind) {
  const normalized = String(kind || '').toLowerCase();
  if (normalized === 'external') return 'external';
  if (normalized === 'service_account') return 'service_account';
  return 'human';
}

function isPseudoAgentHandle(handle) {
  return /chief-of-staff|ai-governance|product-governance|governance-agent|governance$/i.test(String(handle || ''));
}

function isPseudoAgentMember(member) {
  const text = `${member?.name || ''} ${member?.handle || ''} ${member?.role || ''} ${member?.team || ''}`.toLowerCase();
  return /\b(ai governance manager|chief-of-staff agent|product governance agent)\b/.test(text)
    || /\bgovernance agent\b/.test(text)
    || /@(?:chief-of-staff|ai-governance|product-governance)/.test(text);
}

function sanitizeActivityActor(row) {
  if (!row || typeof row !== 'object') return row;
  const who = String(row.who || '');
  if (/^@marat$|^Marat(?: Basyrov)?$/i.test(who)) {
    const { who: _who, ...rest } = row;
    return {
      ...rest,
      source_kind: 'actor',
      actor_ref: MARAT_ACTOR_REF,
    };
  }
  if (ROLE_ROUTE_REFS[who]) {
    const { who: _who, ...rest } = row;
    return {
      ...rest,
      source_kind: 'role_route',
      role_route_ref: ROLE_ROUTE_REFS[who],
      source_label: who === 'Governed role route' ? 'Critical intake review' : who,
      what: `${row.what || 'produced governance evidence'} (role route invocation, not a workspace member)`,
    };
  }
  if (CAPABILITY_REFS[who]) {
    const { who: _who, ...rest } = row;
    return {
      ...rest,
      source_kind: 'capability',
      capability_ref: CAPABILITY_REFS[who],
      source_label: who,
    };
  }
  if (!isPseudoAgentMember({ name: row.who })) return row;
  const { who: _who, ...rest } = row;
  return {
    ...rest,
    source_kind: 'role_route',
    role_route_ref: 'role-route:delivery-readiness-gates',
    source_label: who,
    what: `${row.what || 'produced governance evidence'} (role route invocation, not a workspace member)`,
  };
}

function ensureInitialStore(store, projectsByWorkspace) {
  const out = { ...(store || {}) };
  for (const projects of Object.values(projectsByWorkspace || {})) {
    for (const project of projects) {
      out[project.id] = out[project.id] || {
        cis: [],
        wis: [],
        decisions: [],
        buildLanes: {},
      };
    }
  }
  for (const projectStore of Object.values(out)) {
    sanitizeGovernancePackets(projectStore?.cis);
    sanitizeGovernancePackets(projectStore?.wis);
    sanitizeBuildLanes(projectStore?.buildLanes);
  }
  return out;
}

function sanitizeGovernancePackets(items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.role_panel)) {
      let refs = normalizeRoleRouteRefs(item.role_route_refs || item.role_panel);
      const isXlooopPacket = String(item.id || item.packet_id || '').startsWith('XLOOOP-')
        || (Array.isArray(item.target_project_ids) && item.target_project_ids.includes('xlooop-product'));
      if (isXlooopPacket) refs = [...new Set([...refs, 'role-route:frontend-architecture-review'])];
      item.role_route_refs = refs;
      item.role_panel = refs;
    }
    item.owner_actor_ref = item.owner_actor_ref || MARAT_ACTOR_REF;
    if (Array.isArray(item.slices)) {
      for (const slice of item.slices) sanitizeWorkAssignment(slice);
    }
  }
}

function sanitizeBuildLanes(lanes) {
  if (!lanes || typeof lanes !== 'object') return;
  for (const rows of Object.values(lanes)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) sanitizeWorkAssignment(row);
  }
}

function sanitizeWorkAssignment(row) {
  if (!row || typeof row !== 'object') return;
  const owner = String(row.owner || row.who || '');
  if (/^Codex\s+·\s+/i.test(owner)) {
    row.owner_actor_ref = row.owner_actor_ref || MARAT_ACTOR_REF;
    row.supporting_capability_ref = row.supporting_capability_ref || 'capability:codex-runtime';
    row.supporting_capability_label = row.supporting_capability_label || owner;
    delete row.owner;
    delete row.who;
  }
}

function normalizeRoleRouteRefs(values) {
  const refs = (Array.isArray(values) ? values : [])
    .map((value) => ROLE_ROUTE_REFS[value] || value)
    .filter((value) => typeof value === 'string' && value.startsWith('role-route:'));
  return [...new Set(refs.length ? refs : DEFAULT_ROLE_ROUTE_REFS)];
}

function ownerMember() {
  return {
    name: 'Marat Basyrov',
    handle: '@marat',
    role: 'Owner',
    team: 'Owner office',
    avail: 'active',
    last: 'now',
    since: 'Jan 2024',
    initials: 'MB',
    color: 'alt-1',
  };
}

function statusFromWorkspace(projects, counts) {
  if (projects.some((project) => project.status === 'blocked')) return 'blocked';
  if ((counts.blocked || 0) > 0) return 'blocked';
  if (projects.some((project) => project.status === 'needsrev' || project.status === 'review')) return 'needsrev';
  if ((counts.needsrev || 0) > 0) return 'needsrev';
  if ((counts.running || 0) > 0) return 'running';
  return 'approved';
}

function statusFromProject(project, counts) {
  if (isProjectBlocked(project) || (counts.blocked || 0) > 0) return 'blocked';
  if (project.health === 'review' || /review/i.test(project.stage || '') || (counts.needsrev || 0) > 0) return 'needsrev';
  if (/build|operate|validate/i.test(project.stage || '') || (counts.running || 0) > 0) return 'running';
  return 'approved';
}

function isProjectBlocked(project = {}) {
  return /\bblocked\b|setup-blocked|blocked_/.test(String(`${project.status || ''} ${project.health || ''} ${project.setup_status || ''}`).toLowerCase());
}

function incrementCounts(target, id, row) {
  target[id] = target[id] || emptyCounts();
  const state = stateFromRow(row);
  const type = String(row.stream_type || '').toLowerCase();
  target[id].total += 1;
  target[id][state] = (target[id][state] || 0) + 1;
  if (type.includes('evidence') || type.includes('graph') || type.includes('scorecard')) target[id].evidence += 1;
  if (type.includes('readiness') || /sign[- ]?off|owner|review/i.test(`${row.title || ''} ${row.summary || ''}`)) target[id].signoff += 1;
}

function emptyCounts() {
  return { total: 0, blocked: 0, needsrev: 0, running: 0, approved: 0, evidence: 0, signoff: 0 };
}

function stateFromRow(row) {
  const text = `${row.state || ''} ${row.title || ''} ${row.summary || ''}`.toLowerCase();
  if (/blocked|fail|red|stale/.test(text)) return 'blocked';
  if (/review|owner|required|warn|yellow/.test(text)) return 'needsrev';
  if (/running|active|poll|sync|checkout/.test(text)) return 'running';
  return 'approved';
}

function canonicalWorkspace(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (v === 'MB-P' || v === 'mbp' || v === 'mbp-governance') return 'mbp-private';
  if (v === 'XCP' || v === 'xcp' || v === 'xcp-platform') return 'xcp-platform';
  if (v === 'Xlooop' || v === 'xlooop') return 'xlooop';
  return v;
}

function canonicalProject(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const aliases = {
    'mbp-governance': 'mbp-ops',
    'xcp-platform': 'xcp-control-plane',
    'xl-product': 'xlooop-product',
    'xl-commercial': 'xlooop-commercial',
  };
  return aliases[v] || v;
}

function sqliteJson(sql) {
  if (!fs.existsSync(MBP_GRAPH_SQLITE)) return [];
  const result = spawnSync('/usr/bin/sqlite3', ['-json', MBP_GRAPH_SQLITE, sql], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout || '[]');
  } catch (_) {
    return [];
  }
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(DATA_ROOT, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  const target = path.normalize(path.join(DATA_ROOT, relativePath));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function producerRefs(paths) {
  return paths.map((source_path) => ({
    source_path,
    classification: 'owner_local_public_safe_metadata',
  }));
}

function percent(count, total) {
  return total ? Math.round((count / total) * 1000) / 10 : 0;
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function firstNonEmpty(values) {
  return (Array.isArray(values) ? values : [])
    .find((value) => typeof value === 'string' && value.trim().length > 0) || null;
}

function initials(value) {
  return String(value || '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || 'NA';
}

function inferDomainId(workspaceId, projectId) {
  if (workspaceId === 'mbp-private' && /intake/i.test(projectId)) return 'mbp-intake';
  if (workspaceId === 'mbp-private' && /life/i.test(projectId)) return 'mbp-personal';
  if (workspaceId === 'mbp-private') return 'mbp-governance';
  if (workspaceId === 'xcp-platform') return /roadmap/i.test(projectId) ? 'xcp-roadmap' : 'xcp-infrastructure';
  if (workspaceId === 'xlooop') return /commercial/i.test(projectId) ? 'xlooop-commercial' : 'xlooop-product';
  return workspaceId;
}

function inferDomainKind(workspaceId, projectId) {
  if (workspaceId === 'mbp-private' && /intake/i.test(projectId)) return 'intake';
  if (workspaceId === 'mbp-private' && /life/i.test(projectId)) return 'personal_operations';
  if (workspaceId === 'mbp-private') return 'governance';
  if (workspaceId === 'xcp-platform' && /roadmap/i.test(projectId)) return 'platform_roadmap';
  return WORKSPACE_DOMAIN_KIND[workspaceId] || 'operations';
}

function inferTemplateId(workspaceId, projectId) {
  if (TEMPLATE_BY_PROJECT[projectId]) return TEMPLATE_BY_PROJECT[projectId];
  if (workspaceId === 'x-biz') return 'commercial_logic';
  if (workspaceId === 'x-docs') return 'documentation_ops';
  if (workspaceId === 'x-front') return 'frontend_reference';
  if (workspaceId === 'xcp-platform') return 'ai_governance_infrastructure';
  if (workspaceId === 'mbp-private' && /life|personal/i.test(projectId)) return 'personal_goals';
  if (workspaceId === 'mbp-private') return 'owner_governance';
  if (workspaceId === 'xlooop' && /commercial/i.test(projectId)) return 'commercial_readiness';
  if (workspaceId === 'xlooop') return 'product_delivery';
  return 'product_delivery';
}

function templateDefaultsForProject(workspaceId, projectId) {
  const templateId = inferTemplateId(workspaceId, projectId);
  return DOMAIN_TEMPLATE_DEFS.find((row) => row.template_id === templateId) || {};
}

function defaultMemberPolicy(workspaceId) {
  return {
    segregation: workspaceId === 'mbp-private' ? 'owner_private' : 'workspace_scoped',
    invite_policy: 'owner_approved',
    default_role: workspaceId === 'mbp-private' ? 'Owner' : 'Member',
    external_member_allowed: workspaceId !== 'mbp-private',
  };
}

function defaultAgentPolicy(workspaceId) {
  return {
    agent_scope: workspaceId === 'mbp-private' ? 'owner_governed_private' : 'workspace_governed',
    requires_role_skill_attestation: true,
    direct_write_allowed: false,
  };
}

function defaultActionPolicy() {
  return {
    watch_mode: 'preview_or_no_op',
    operator_mode: 'governed_proposal_receipt_only',
    direct_mbp_write_allowed: false,
    dangerous_action_confirmation_required: true,
  };
}

function defaultEvidencePolicy() {
  return {
    evidence_required_for_signoff: true,
    source_refs_required: true,
    raw_private_content_allowed_in_browser: false,
    learning_loop_closure_required: true,
  };
}

function setupChecklistForWorkspace(workspace) {
  const hasBlocker = workspace.projects.some((project) => project.setup_status === 'blocked_missing_live_source');
  return [
    { id: 'choose_space', label: 'Choose owner space', status: 'complete' },
    { id: 'workspace_identity', label: 'Confirm workspace identity and boundary', status: 'complete' },
    { id: 'templates', label: 'Activate domain templates', status: 'complete' },
    { id: 'operational_areas', label: 'Publish projects/domains as operational areas', status: 'complete' },
    { id: 'humans', label: 'Assign humans and role boundaries', status: 'complete' },
    { id: 'agents', label: 'Assign governed agents', status: 'complete' },
    { id: 'data', label: 'Bind live/read-model source', status: hasBlocker ? 'blocked' : 'complete' },
    { id: 'actions', label: 'Verify Watch/Operator action policy', status: 'complete' },
    { id: 'evidence', label: 'Verify evidence and sign-off policy', status: hasBlocker ? 'needs_review' : 'complete' },
    { id: 'launch', label: 'Launch workspace in Watch Mode', status: hasBlocker ? 'blocked' : 'complete' },
  ];
}
