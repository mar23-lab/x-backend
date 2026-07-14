#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tree = readJson('data/workspace-tree-read-model.json');
const sourceMap = readJson('data/operational-area-source-map.json');
const templates = readJson('data/domain-template-catalog.json');
const areas = Array.isArray(sourceMap.areas) ? sourceMap.areas : [];
const projects = (tree.workspaces || []).flatMap((workspace) => (workspace.projects || []).map((project) => ({ workspace, project })));
const requiredProjectFields = ['space_id', 'area_kind', 'template_id', 'source_binding_status', 'setup_status', 'member_policy', 'agent_policy', 'action_policy'];
const failures = [];

if (tree.schema_version !== 'xlooop.workspace_tree_read_model.v1') failures.push('workspace tree schema mismatch');
if (sourceMap.schema_version !== 'xlooop.operational_area_source_map.v1') failures.push('source map schema mismatch');
if (templates.schema_version !== 'xlooop.domain_template_catalog.v1') failures.push('template catalog schema mismatch');
if (projects.length < 21) failures.push(`expected at least 21 projects/domains, got ${projects.length}`);
if (areas.length !== projects.length) failures.push(`source map area count ${areas.length} does not match project count ${projects.length}`);

for (const { project } of projects) {
  for (const field of requiredProjectFields) {
    if (project[field] == null || project[field] === '') failures.push(`${project.id} missing ${field}`);
  }
  const area = sourceMap.area_by_id?.[project.id] || areas.find((row) => row.area_id === project.id);
  if (!area) failures.push(`${project.id} missing source-map area`);
}

const workspaceIds = new Set((tree.workspaces || []).map((workspace) => workspace.id));
for (const id of ['mbp-private', 'xcp-platform', 'xlooop', 'x-biz', 'x-docs', 'x-front']) {
  if (!workspaceIds.has(id)) failures.push(`missing workspace ${id}`);
}

emit({
  verifier: 'verify-hierarchy-contracts',
  status: failures.length ? 'FAIL' : 'PASS',
  metrics: {
    workspace_count: workspaceIds.size,
    project_count: projects.length,
    area_count: areas.length,
    template_count: (templates.templates || []).length,
    classified_percent: pct(projects.filter(({ project }) => requiredProjectFields.every((field) => project[field] != null)).length, projects.length),
  },
  failures,
});

if (failures.length) process.exit(1);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function pct(count, total) {
  return total ? Math.round((count / total) * 1000) / 10 : 0;
}

function emit(report) {
  const readOnly = process.env.XCP_VERIFY_READONLY !== '0';
  const outRoot = readOnly
    ? path.join('/private/tmp', 'xlooop-xcp-demo-readonly-audits')
    : path.join(repoRoot, 'docs', 'audits');
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, 'hierarchy-contracts.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.verifier} · ${report.status} · ${report.metrics.project_count} areas`);
}
