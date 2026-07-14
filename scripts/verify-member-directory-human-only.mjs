#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const model = json('data/member-directory-read-model.json');
const forbidden = /AI Governance Manager|Chief-of-Staff Agent|Product Governance Agent|\bGovernance Agent\b/i;

check(model.schema_version === 'xlooop.member_directory_read_model.v1', 'schema');
check(model.active_runtime_fiction_allowed === false, 'active_runtime_fiction_forbidden');
check(model.member_scope_policy === 'human_external_service_account_only', 'human_only_policy');
for (const member of model.members || []) {
  check(!forbidden.test(`${member.name} ${member.handle} ${member.roles?.map((r) => `${r.role} ${r.team}`).join(' ')}`), `no_pseudo_agent_member:${member.name}`);
  check(!/agent/i.test(String(member.kind || '')), `no_agent_kind:${member.name}`);
  check(['human', 'external', 'service_account'].includes(member.kind), `valid_member_kind:${member.name}`);
}

finish('member-directory-human-only', { members: model.members?.length || 0 });

function json(rel) { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }
function check(ok, id) { if (!ok) failures.push(id); }
function finish(name, extra) {
  console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', ...extra, failures }, null, 2));
  process.exit(failures.length ? 1 : 0);
}
