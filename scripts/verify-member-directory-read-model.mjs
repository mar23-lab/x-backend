#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const failures = [];
const forbidden = ['Acme', 'Northshore', 'Sam Patel', 'Sarah Chen', 'TrinityOps', 'Client / invited'];

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function json(rel) { return JSON.parse(read(rel)); }
function check(id, ok, detail = {}) { if (!ok) failures.push({ id, ...detail }); }

const model = json('data/member-directory-read-model.json');
const haystack = [
  read('data/member-directory-read-model.json'),
  read('data/ws-detail.json'),
  read('data/spaces.json'),
].join('\n');
const workspaceIds = json('data/workspace-tree-read-model.json').workspaces.map((workspace) => workspace.id);

check('schema', model.schema_version === 'xlooop.member_directory_read_model.v1');
check('source_mode_generated', model.source_mode === 'generated_live_snapshot');
check('members_exist', Array.isArray(model.members) && model.members.length >= 1, { count: model.members?.length });
check('active_runtime_fiction_forbidden', model.active_runtime_fiction_allowed === false);
for (const marker of forbidden) check(`forbidden_marker_absent:${marker}`, !haystack.includes(marker));
for (const workspaceId of workspaceIds) {
  check(
    `workspace_role_covered:${workspaceId}`,
    model.members.some((member) => (member.workspaces || []).includes(workspaceId)),
    { workspaceId },
  );
}
check('role_coverage_100', model.metrics?.workspace_role_coverage_percent === 100, { metrics: model.metrics });

console.log(JSON.stringify({
  status: failures.length ? 'FAIL' : 'PASS',
  members: model.members.length,
  role_coverage_percent: model.metrics?.workspace_role_coverage_percent,
  failures,
}, null, 2));
process.exit(failures.length ? 1 : 0);
