#!/usr/bin/env node
// verify-postgres-rls-phase2.mjs · static/live verifier for external-customer RLS Phase 2.
//
// Static mode proves the migration carries required tables, ENABLE RLS, policies,
// and same-workspace triggers. Live mode additionally queries pg_catalog on the
// target DATABASE_URL. It intentionally does not print secrets.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { neon } from '@neondatabase/serverless';

const ROOT = process.cwd();
const MIGRATION = resolve(ROOT, 'src/workers/db/migrations/034_operational_spine_rls_phase2.sql');
const TABLES = [
  'task_packets',
  'evidence_items',
  'approval_requests',
  'tool_events',
  'metric_deltas',
];

const sqlText = readFileSync(MIGRATION, 'utf8');
const failures = [];
const warnings = [];

for (const table of TABLES) {
  if (!new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`, 'i').test(sqlText)) {
    failures.push(`missing table ${table}`);
  }
  if (!new RegExp(`ALTER TABLE\\s+${table}\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(sqlText)) {
    failures.push(`missing ENABLE RLS for ${table}`);
  }
  if (!new RegExp(`CREATE POLICY\\s+${table}_workspace_policy\\s+ON\\s+${table}`, 'i').test(sqlText)) {
    failures.push(`missing workspace policy for ${table}`);
  }
  const workspaceIndexRe = new RegExp(
    `CREATE INDEX IF NOT EXISTS\\s+idx_[\\w_]+[\\s\\S]+?ON\\s+${table}\\s*\\(workspace_id`,
    'i',
  );
  if (!workspaceIndexRe.test(sqlText)) {
    failures.push(`missing workspace index evidence for ${table}`);
  }
}

for (const forbidden of [
  'raw_graph_export',
  'full_tenant_memory_export',
  'internal_template_export',
  'governance_scoring_export',
  'private_graph_schema_export',
  'secret_access',
  'search_all_memory',
]) {
  if (!sqlText.includes(forbidden)) {
    failures.push(`forbidden tool marker missing from task_packets default: ${forbidden}`);
  }
}

for (const trigger of [
  'trg_evidence_items_same_workspace',
  'trg_approval_requests_same_workspace',
  'trg_tool_events_same_workspace',
  'trg_metric_deltas_same_workspace',
]) {
  if (!sqlText.includes(trigger)) failures.push(`missing same-workspace trigger ${trigger}`);
}

if (!sqlText.includes("current_setting('xlooop.current_workspace_id', true)")) {
  failures.push('RLS policy does not bind to xlooop.current_workspace_id');
}

if (!/INSERT INTO workers_schema_version \(version, description\)\s+VALUES \(34,/i.test(sqlText)) {
  failures.push('migration does not record workers_schema_version 34');
}

async function liveCheck() {
  if (!process.env.DATABASE_URL) {
    warnings.push('DATABASE_URL not set; skipped live pg_catalog RLS verification');
    return null;
  }
  const db = neon(process.env.DATABASE_URL);
  const rows = await db/*sql*/`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls_enabled,
           count(p.polname)::int AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE c.relkind = 'r'
       AND n.nspname = 'public'
       AND c.relname = ANY(${TABLES})
     GROUP BY c.relname, c.relrowsecurity
     ORDER BY c.relname
  `;
  const byName = new Map(rows.map((r) => [String(r.table_name), r]));
  for (const table of TABLES) {
    const row = byName.get(table);
    if (!row) failures.push(`live DB missing table ${table}`);
    else {
      if (!row.rls_enabled) failures.push(`live DB has RLS disabled for ${table}`);
      if (Number(row.policy_count) < 1) failures.push(`live DB missing policy for ${table}`);
    }
  }
  return rows;
}

async function appRoleCheck() {
  const appUrl = process.env.XLOOOP_RLS_APP_DATABASE_URL || process.env.APP_DATABASE_URL || '';
  if (!appUrl) {
    const message = 'XLOOOP_RLS_APP_DATABASE_URL not set; skipped non-owner app-role RLS verification';
    if (process.env.XLOOOP_REQUIRE_APP_ROLE_RLS === '1') failures.push(message);
    else warnings.push(message);
    return null;
  }
  const db = neon(appUrl);
  const roleRows = await db/*sql*/`
    SELECT current_user AS role_name,
           r.rolsuper AS is_superuser,
           r.rolbypassrls AS bypasses_rls
      FROM pg_roles r
     WHERE r.rolname = current_user
     LIMIT 1
  `;
  const role = roleRows[0];
  if (!role) failures.push('app-role verification could not inspect current_user');
  else {
    if (role.is_superuser) failures.push(`app role ${role.role_name} is superuser`);
    if (role.bypasses_rls) failures.push(`app role ${role.role_name} has BYPASSRLS`);
  }

  const tableRows = await db/*sql*/`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS force_rls,
           count(p.polname)::int AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE c.relkind = 'r'
       AND n.nspname = 'public'
       AND c.relname = ANY(${TABLES})
     GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
     ORDER BY c.relname
  `;
  const byName = new Map(tableRows.map((r) => [String(r.table_name), r]));
  for (const table of TABLES) {
    const row = byName.get(table);
    if (!row) failures.push(`app-role DB missing table ${table}`);
    else {
      if (!row.rls_enabled) failures.push(`app-role DB has RLS disabled for ${table}`);
      if (Number(row.policy_count) < 1) failures.push(`app-role DB missing policy for ${table}`);
    }
  }

  const contextRows = await db/*sql*/`
    SELECT current_setting('xlooop.current_workspace_id', true) AS workspace_context_before_set
  `;
  return { role, tables: tableRows, workspace_context_before_set: contextRows[0]?.workspace_context_before_set ?? null };
}

const liveRows = await liveCheck().catch((err) => {
  failures.push(`live pg_catalog RLS verification failed: ${err?.message || String(err)}`);
  return null;
});

const appRoleRows = await appRoleCheck().catch((err) => {
  failures.push(`app-role RLS verification failed: ${err?.message || String(err)}`);
  return null;
});

const result = {
  schema_id: 'xlooop.postgres_rls_phase2_verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  migration: MIGRATION,
  tables: TABLES,
  static_checks: failures.length ? 'FAIL' : 'PASS',
  live_checks: liveRows ? 'checked' : 'skipped',
  app_role_checks: appRoleRows ? 'checked' : 'skipped',
  failures,
  warnings,
};

console.log(JSON.stringify(result, null, 2));
process.exit(failures.length ? 1 : 0);
