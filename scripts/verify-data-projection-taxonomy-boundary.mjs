#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const members = json('data/member-directory-read-model.json');
const routes = json('data/governed-role-route-projection.json');
const capabilities = json('data/agent-capability-projection.json');
check(members.member_scope_policy === 'human_external_service_account_only', 'members_human_only_policy');
check(routes.member_directory_policy === 'role_routes_are_not_members', 'routes_not_members_policy');
check(capabilities.member_directory_policy === 'capabilities_are_not_members', 'capabilities_not_members_policy');
check(capabilities.agent_profile_status === 'deferred', 'agent_profile_deferred');

for (const member of members.members || []) {
  if (!['human', 'external', 'service_account'].includes(member.kind)) {
    failures.push(`member:${member.id || member.name}:invalid_kind:${member.kind}`);
  }
}

for (const rel of ['data/home.json', 'data/ws-detail.json']) {
  walk(json(rel), (value, keyPath, parent) => {
    const key = keyPath.at(-1);
    if (key === 'who' && typeof value === 'string' && /Chief-of-Staff|Knowledge Architect|Governance Agent|Governed role route|Codex/i.test(value)) {
      failures.push(`${rel}:${keyPath.join('.')}:ambiguous_who:${value}`);
    }
    if (key === 'source_kind' && typeof value === 'string') {
      const hasTypedRef = !!(parent?.actor_ref || parent?.role_route_ref || parent?.capability_ref || parent?.runtime_event_ref || parent?.receipt_ref || value === 'system');
      if (!hasTypedRef) failures.push(`${rel}:${keyPath.join('.')}:source_kind_without_ref:${value}`);
    }
  });
}

walk(json('data/initial-store.json'), (value, keyPath) => {
  if (keyPath.at(-1) !== 'role_panel' || !Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.startsWith('role-route:')) {
      failures.push(`data/initial-store.json:${keyPath.join('.')}:role_panel_not_route_ref:${entry}`);
    }
  }
});

finish('data-projection-taxonomy-boundary');

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function json(rel) { return JSON.parse(read(rel)); }
function check(ok, id) { if (!ok) failures.push(id); }
function walk(value, visitor, keyPath = [], parent = null) {
  visitor(value, keyPath, parent);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visitor, keyPath.concat(String(index)), value));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => walk(child, visitor, keyPath.concat(key), value));
}
function finish(name) {
  console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', failures }, null, 2));
  process.exit(failures.length ? 1 : 0);
}
