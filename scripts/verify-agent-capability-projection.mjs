#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const model = json('data/agent-capability-projection.json');

check(model.schema_version === 'xlooop.agent_capability_projection.v1', 'schema');
check(model.contract_ref === 'AgentCapabilityProjection.v1', 'contract_ref');
check(model.member_directory_policy === 'capabilities_are_not_members', 'capability_policy');
check(model.agent_profile_status === 'deferred', 'agent_profile_deferred');
check(Array.isArray(model.capabilities) && model.capabilities.length >= 4, 'capabilities_present');
for (const capability of model.capabilities || []) {
  check(capability.capability_id && capability.label, `identity:${capability.capability_id}`);
  check(capability.provider && capability.capability_type, `provider_type:${capability.capability_id}`);
  check(Array.isArray(capability.supported_modes) && capability.supported_modes.length, `modes:${capability.capability_id}`);
  check(typeof capability.entitlement_required === 'boolean', `entitlement:${capability.capability_id}`);
  check(capability.receipt_policy, `receipt_policy:${capability.capability_id}`);
  check(capability.current_status, `status:${capability.capability_id}`);
  check(capability.boundary_note && capability.source_ref, `boundary_source:${capability.capability_id}`);
}

finish('agent-capability-projection', { capabilities: model.capabilities?.length || 0 });

function json(rel) { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }
function check(ok, id) { if (!ok) failures.push(id); }
function finish(name, extra) {
  console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', ...extra, failures }, null, 2));
  process.exit(failures.length ? 1 : 0);
}
