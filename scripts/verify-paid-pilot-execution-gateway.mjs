#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const policy = json('data/paid-pilot-action-policy.json');
const authority = read('functions/_lib/paid-pilot-authority.js');
const migration = read('migrations/0003_paid_pilot_authority.sql');
const routes = [
  'functions/api/actions/propose.js',
  'functions/api/actions/approve.js',
  'functions/api/actions/execute.js',
  'functions/api/actions/rollback.js',
  'functions/api/actions/[id].js',
].map(read).join('\n');

check('policy_schema', policy.schema_version === 'xlooop.paid_pilot_action_policy.v1');
check('default_deny', policy.default_policy === 'deny');
for (const action of [
  'feedback.resolve',
  'proposal.approve',
  'proposal.reject',
  'telemetry.company.aggregate.read',
  'document.markdown.writeback.request',
  'document.markdown.writeback.apply',
]) {
  check(`allowed_action:${action}`, policy.allowed_actions.some((entry) => entry.action_type === action));
  check(`runtime_allowlist:${action}`, authority.includes(`'${action}'`));
}
for (const status of ['proposed', 'approved', 'denied', 'executed', 'rolled_back', 'superseded']) {
  check(`status:${status}`, authority.includes(`'${status}'`));
}
for (const field of [
  'action_id',
  'tenant_id',
  'identity_id',
  'actor_id',
  'action_type',
  'target_ref',
  'graph_path',
  'requested_mode',
  'policy_decision',
  'status',
  'idempotency_key',
  'proposal_id',
  'approval_id',
  'receipt_id',
  'verifier_ref',
  'rollback_ref',
]) {
  check(`receipt_field:${field}`, migration.includes(`${field} text`) || migration.includes(`${field} text not null`) || authority.includes(`${field}:`));
}
check('idempotency_unique', migration.includes('unique(tenant_id, action_type, idempotency_key)'));
check('idempotency_replay', authority.includes('findByIdempotency') && authority.includes('replayed'));
check('non_allowlisted_denied', authority.includes('action_not_allowed'));
check('approval_required', authority.includes('approval_required') && authority.includes('approval_id'));
check('audit_success_and_denial', authority.includes('action_denied') && authority.includes('action_executed') && authority.includes('proposal_created'));
check('routes_use_paid_authority', routes.includes('requirePaidPilotPrincipal') && routes.includes('executeAction') && routes.includes('rollbackAction'));
check('redacted_responses', routes.includes('customerSafeJson'));

finish('verify-paid-pilot-execution-gateway');

function check(id, ok) {
  if (!ok) failures.push(id);
}

function finish(name) {
  if (failures.length) {
    console.error(`${name}: FAIL`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`${name}: PASS`);
}
