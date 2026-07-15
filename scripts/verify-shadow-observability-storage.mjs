#!/usr/bin/env node
import fs from 'node:fs';

const checks = [
  {
    path: 'src/workers/db/migrations/077_current_work_parity_observations.sql',
    table: 'current_work_parity_observations',
    required: ['STAGED ONLY', 'ENABLE ROW LEVEL SECURITY', 'USING (workspace_id = xlooop_rls_workspace_id())', 'WITH CHECK (workspace_id = xlooop_rls_workspace_id())'],
    forbiddenColumns: ['title', 'prompt', 'body', 'evidence_content', 'object_id'],
  },
  {
    path: 'src/workers/db/migrations/078_model_execution_receipts.sql',
    table: 'model_execution_receipts',
    required: ['STAGED ONLY', 'REFERENCES role_skill_resolutions(id)', 'REFERENCES context_packets(id)', 'ENABLE ROW LEVEL SECURITY', 'USING (workspace_id = xlooop_rls_workspace_id())', 'WITH CHECK (workspace_id = xlooop_rls_workspace_id())'],
    forbiddenColumns: ['prompt', 'response', 'body', 'content', 'source_body', 'document_body'],
  },
];

const errors = [];
for (const check of checks) {
  const sql = fs.readFileSync(check.path, 'utf8');
  for (const token of check.required) if (!sql.includes(token)) errors.push(`${check.path}: missing ${token}`);
  const tableMatch = sql.match(new RegExp(`CREATE TABLE ${check.table} \\(([\\s\\S]*?)\\n    \\);`));
  if (!tableMatch) {
    errors.push(`${check.path}: CREATE TABLE block not found`);
    continue;
  }
  const columnNames = tableMatch[1].split('\n').map((line) => line.trim().split(/\s+/)[0]?.replace(/,$/, '')).filter(Boolean);
  for (const forbidden of check.forbiddenColumns) {
    if (columnNames.includes(forbidden)) errors.push(`${check.path}: forbidden customer-content column ${forbidden}`);
  }
}

const currentWorkRoute = fs.readFileSync('src/workers/routes/current-work.ts', 'utf8');
if (!currentWorkRoute.includes("envFlagTrue(ctx.env.CURRENT_WORK_PARITY_OBSERVATIONS_ENABLED)")) errors.push('Current Work parity writes are not flag-gated');
const lineagePolicy = fs.readFileSync('src/workers/lib/model-execution-lineage.ts', 'utf8');
if (!lineagePolicy.includes('envFlagTrue(env.CONTEXT_PACKET_PERSISTENCE_ENABLED)')) errors.push('model execution receipts are not strict-flag-gated');

if (errors.length > 0) {
  console.error(JSON.stringify({ status: 'fail', errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  status: 'pass',
  staged_migrations_checked: checks.map((check) => check.path),
  rls_policy_coverage_pct: 100,
  forbidden_customer_content_columns: 0,
  default_off_write_paths: 2,
}, null, 2));
