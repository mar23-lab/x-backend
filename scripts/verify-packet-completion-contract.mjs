#!/usr/bin/env node
import fs from 'node:fs';

const migration = fs.readFileSync('src/workers/db/migrations/073_packet_completion_contract.sql', 'utf8');
const route = fs.readFileSync('src/workers/routes/operational-spine.ts', 'utf8');
const store = fs.readFileSync('src/workers/dal/operational-spine-store.ts', 'utf8');
const requiredColumns = [
  'version', 'requested_output', 'acceptance_criteria', 'acceptance_status', 'evidence_required',
  'execution_status', 'blockers_accepted', 'receipt_required', 'plan_projection_required',
  'plan_projection_updated_at', 'completed_at', 'packet_version',
];
const failures = [];

for (const column of requiredColumns) {
  if (!migration.includes(column)) failures.push(`migration 073 missing ${column}`);
}
if (!migration.includes('STAGED ONLY')) failures.push('migration 073 must remain explicitly staged');
if (!route.includes('PACKET_COMPLETION_EVALUATION_ENABLED')) failures.push('completion route is not fail-closed behind its flag');
if (!route.includes("get('/packets/:id/completion-evaluation'")) failures.push('completion evaluation route missing');
if (!store.includes('evaluateCompletion({')) failures.push('server facts are not wired to the pure completion evaluator');
if (!store.includes('ar.packet_version')) failures.push('approval lookup is not packet-version bound');
if (!store.includes('p.workspace_id = ${workspaceId}')) failures.push('completion facts are not workspace scoped');
if (!migration.includes('xlooop_bind_approval_packet_version')) failures.push('approval writes lack same-workspace packet-version binding');
if (!migration.includes("packet_id does not exist in approval workspace")) failures.push('cross-workspace approval packet IDs do not fail closed');

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  process.exit(1);
}
console.log('PASS packet completion contract: staged additive schema, server-derived facts, tenant scope, version-bound approvals, default-off route');
