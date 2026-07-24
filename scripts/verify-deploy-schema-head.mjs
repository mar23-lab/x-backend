#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = resolve(root, 'src/workers/db/migrations');
const selfTest = process.argv.includes('--self-test');

export function assessSchemaHead({ configured, database, local }) {
  const problems = [];
  for (const [name, value] of Object.entries({ configured, database, local })) {
    if (!Number.isSafeInteger(value) || value < 1) problems.push(`${name}_not_positive_integer`);
  }
  if (problems.length === 0 && configured !== database) problems.push('configured_database_mismatch');
  if (problems.length === 0 && database !== local) problems.push('database_local_mismatch');
  return { ok: problems.length === 0, problems };
}

function localMigrationHead() {
  const versions = readdirSync(migrationsDir)
    .map((name) => name.match(/^(\d+)_.*\.sql$/)?.[1])
    .filter(Boolean)
    .map(Number);
  if (versions.length === 0) throw new Error('no numbered migration files found');
  return Math.max(...versions);
}

function runSelfTest() {
  const controls = [
    [assessSchemaHead({ configured: 89, database: 89, local: 89 }).ok, true, 'matching heads'],
    [assessSchemaHead({ configured: 88, database: 89, local: 89 }).ok, false, 'stale configured head'],
    [assessSchemaHead({ configured: 89, database: 88, local: 89 }).ok, false, 'unapplied local migration'],
    [assessSchemaHead({ configured: Number.NaN, database: 89, local: 89 }).ok, false, 'invalid configured head'],
  ];
  const failed = controls.filter(([actual, expected]) => actual !== expected);
  if (failed.length > 0) {
    console.error(`verify-deploy-schema-head self-test FAIL: ${failed.map((row) => row[2]).join(', ')}`);
    process.exit(1);
  }
  console.log('verify-deploy-schema-head self-test PASS · matching/mismatch/invalid controls');
}

async function main() {
  if (selfTest) return runSelfTest();

  const configured = Number(process.env.XLOOOP_SCHEMA_HEAD);
  if (!process.env.DATABASE_URL) {
    console.error('verify-deploy-schema-head · FAIL-CLOSED · DATABASE_URL is required');
    process.exit(1);
  }

  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`SELECT max(version)::integer AS head FROM workers_schema_version`;
    const database = Number(rows[0]?.head);
    const local = localMigrationHead();
    const result = assessSchemaHead({ configured, database, local });
    if (!result.ok) {
      console.error('verify-deploy-schema-head · FAIL-CLOSED');
      console.error(`  configured=${String(configured)} database=${String(database)} local=${String(local)}`);
      console.error(`  problems=${result.problems.join(',')}`);
      process.exit(1);
    }
    console.log(`verify-deploy-schema-head · PASS · configured=database=local=${configured}`);
  } catch (error) {
    console.error(`verify-deploy-schema-head · FAIL-CLOSED · ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
