#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BRIDGE_PATH = resolve('src/workers/db/baselines/092_production_drift_bridge.sql');
const MIGRATION_PATH = resolve('src/workers/db/migrations/092_tenant_bearing_rls_enable.sql');
const APPLIED_MIGRATION_SHA256 = '08954095fbf160e704192acac581b0dd78d238077984acda3c322d7a952678ee';
const BRIDGE_TABLES = [
  'investor_entitlements',
  'source_repos',
  'user_source_connections_legacy_v0_260606',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assessBridge(bridgeSql, migrationSql) {
  const problems = [];
  const executable = stripComments(bridgeSql);

  if (sha256(migrationSql) !== APPLIED_MIGRATION_SHA256) {
    problems.push('applied migration 092 changed');
  }
  if (!/REPLAY-ONLY BASELINE/i.test(bridgeSql)) {
    problems.push('bridge is not marked replay-only');
  }
  if (!/not a production migration/i.test(bridgeSql)) {
    problems.push('bridge lacks the production-use prohibition');
  }

  for (const table of BRIDGE_TABLES) {
    const name = escapeRegExp(table);
    if (!new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(?:public\\.)?${name}\\b`, 'i').test(executable)) {
      problems.push(`bridge does not create ${table}`);
    }
    if (!new RegExp(`['\"]${name}['\"]`).test(migrationSql)) {
      problems.push(`migration 092 no longer targets ${table}`);
    }
  }

  const mutationScan = executable.replace(
    /\bON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT)\b/gi,
    ' ',
  );
  const forbiddenDataMutation = mutationScan.match(/\b(INSERT|UPDATE|DELETE|COPY|TRUNCATE|MERGE)\b/i)?.[1];
  if (forbiddenDataMutation) {
    problems.push(`bridge contains forbidden data mutation: ${forbiddenDataMutation.toUpperCase()}`);
  }
  if (/workers_schema_version/i.test(executable)) {
    problems.push('bridge must not claim a migration version');
  }
  if (/DATABASE_URL|neon\.tech|flat-truth-23350426|br-dark-credit-a7tb4yhu/i.test(bridgeSql)) {
    problems.push('bridge contains a production connection or provider identity');
  }

  return problems;
}

const bridgeSql = readFileSync(BRIDGE_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

if (process.argv.includes('--self-test')) {
  const cases = [
    assessBridge(bridgeSql, migrationSql).length === 0,
    assessBridge(
      bridgeSql.replace('CREATE TABLE IF NOT EXISTS public.source_repos', 'CREATE VIEW public.source_repos'),
      migrationSql,
    ).includes('bridge does not create source_repos'),
    assessBridge(`${bridgeSql}\nINSERT INTO source_repos (id) VALUES ('x');`, migrationSql)
      .includes('bridge contains forbidden data mutation: INSERT'),
    assessBridge(bridgeSql, `${migrationSql}\n-- changed`).includes('applied migration 092 changed'),
    assessBridge(`${bridgeSql}\n-- DATABASE_URL`, migrationSql)
      .includes('bridge contains a production connection or provider identity'),
  ];
  if (cases.every(Boolean)) {
    console.log('verify-schema92-replay-bridge self-test PASS (4/4 mutants RED)');
    process.exit(0);
  }
  console.error('verify-schema92-replay-bridge self-test FAIL');
  process.exit(1);
}

const problems = assessBridge(bridgeSql, migrationSql);
if (problems.length) {
  console.error(`verify-schema92-replay-bridge · FAIL-CLOSED · ${problems.join('; ')}`);
  process.exit(1);
}

console.log(
  `verify-schema92-replay-bridge · PASS · ${BRIDGE_TABLES.length}/3 drift tables represented; `
  + '0 data mutations; migration 092 immutable',
);
