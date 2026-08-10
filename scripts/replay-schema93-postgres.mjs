#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const MIGRATION_DIR = resolve('src/workers/db/migrations');
const BRIDGE_PATH = resolve('src/workers/db/baselines/092_production_drift_bridge.sql');

function localDatabaseUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) return true;
    const socketHost = parsed.searchParams.get('host') ?? '';
    return hostname === '' && (socketHost.startsWith('/private/tmp') || socketHost.startsWith('/tmp'));
  } catch {
    return false;
  }
}

export function assessEnvironment(env) {
  const url = String(env.XLOOOP_SCHEMA_REPLAY_PG_URL ?? '').trim();
  const productionUrl = String(env.DATABASE_URL ?? '').trim();
  const problems = [];

  if (!url) problems.push('XLOOOP_SCHEMA_REPLAY_PG_URL is required');
  if (env.XLOOOP_SCHEMA_REPLAY_DISPOSABLE !== '1') {
    problems.push('XLOOOP_SCHEMA_REPLAY_DISPOSABLE=1 is required');
  }
  if (url && !localDatabaseUrl(url)) {
    problems.push('replay database must be local PostgreSQL');
  }
  if (url && productionUrl && url === productionUrl) {
    problems.push('replay database must not equal DATABASE_URL');
  }
  return problems;
}

function migrationFiles() {
  return readdirSync(MIGRATION_DIR)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => resolve(MIGRATION_DIR, name));
}

export function latestMigrationVersion(files) {
  return Math.max(...files.map((file) => Number(file.match(/\/(\d{3})_[^/]+\.sql$/)?.[1] ?? 0)));
}

function replaySequence(files) {
  const sequence = [];
  for (const file of files) {
    if (/\/092_[^/]+\.sql$/.test(file)) sequence.push(BRIDGE_PATH);
    sequence.push(file);
  }
  return sequence;
}

function psqlBinary(env) {
  const configured = String(env.PSQL_BIN ?? '').trim();
  if (configured) return configured;
  const candidates = [
    '/opt/homebrew/opt/postgresql@17/bin/psql',
    '/opt/homebrew/opt/postgresql@16/bin/psql',
    'psql',
  ];
  return candidates.find((candidate) => candidate === 'psql' || existsSync(candidate)) ?? 'psql';
}

function runPsql(binary, url, args, stdio = 'inherit') {
  const result = spawnSync(binary, ['-X', '--set', 'ON_ERROR_STOP=1', '--dbname', url, ...args], {
    encoding: 'utf8',
    stdio,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return String(result.stdout ?? '').trim();
}

function ensureReplayRole(binary, url) {
  runPsql(binary, url, [
    '--command',
    `DO $role$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
         CREATE ROLE xlooop_app NOLOGIN;
       END IF;
     END
     $role$;`,
  ]);
}

if (process.argv.includes('--self-test')) {
  const files = [
    '/tmp/091_conversation.sql',
    '/tmp/092_rls.sql',
    '/tmp/093_strict.sql',
  ];
  const sequence = replaySequence(files);
  const headFiles = ['/tmp/099_chat.sql', '/tmp/100_authority.sql'];
  const cases = [
    assessEnvironment({}).length === 2,
    assessEnvironment({
      XLOOOP_SCHEMA_REPLAY_PG_URL: 'postgresql://127.0.0.1:55439/replay',
      XLOOOP_SCHEMA_REPLAY_DISPOSABLE: '1',
    }).length === 0,
    assessEnvironment({
      XLOOOP_SCHEMA_REPLAY_PG_URL: 'postgresql://example.neon.tech/neondb',
      XLOOOP_SCHEMA_REPLAY_DISPOSABLE: '1',
    }).includes('replay database must be local PostgreSQL'),
    assessEnvironment({
      DATABASE_URL: 'postgresql://127.0.0.1/prod',
      XLOOOP_SCHEMA_REPLAY_PG_URL: 'postgresql://127.0.0.1/prod',
      XLOOOP_SCHEMA_REPLAY_DISPOSABLE: '1',
    }).includes('replay database must not equal DATABASE_URL'),
    sequence[1] === BRIDGE_PATH && sequence.filter((item) => item === BRIDGE_PATH).length === 1,
    latestMigrationVersion(headFiles) === 100,
  ];
  if (cases.every(Boolean)) {
    console.log('replay-schema-head-postgres self-test PASS');
    process.exit(0);
  }
  console.error('replay-schema-head-postgres self-test FAIL');
  process.exit(1);
}

const problems = assessEnvironment(process.env);
if (problems.length) {
  console.error(`replay-schema-head-postgres · FAIL-CLOSED · ${problems.join('; ')}`);
  process.exit(2);
}

const url = process.env.XLOOOP_SCHEMA_REPLAY_PG_URL.trim();
const binary = psqlBinary(process.env);
const publicTableCount = runPsql(binary, url, [
  '--tuples-only', '--no-align', '--command',
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');",
], 'pipe');
if (publicTableCount !== '0') {
  console.error(`replay-schema-head-postgres · FAIL-CLOSED · database is not empty (${publicTableCount} public tables)`);
  process.exit(2);
}

ensureReplayRole(binary, url);

const files = migrationFiles();
const expectedHead = latestMigrationVersion(files);
for (const file of replaySequence(files)) {
  console.log(`replay-schema-head-postgres · apply ${file.replace(`${process.cwd()}/`, '')}`);
  runPsql(binary, url, ['--file', file]);
}

const verification = runPsql(binary, url, [
  '--tuples-only', '--no-align', '--field-separator', '|', '--command',
  `SELECT
     (SELECT max(version) FROM workers_schema_version),
     (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname IN ('investor_entitlements', 'source_repos', 'user_source_connections_legacy_v0_260606')),
     (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
         AND c.relname IN ('investor_entitlements', 'source_repos', 'user_source_connections_legacy_v0_260606')),
     (SELECT count(*) FROM investor_entitlements),
     (SELECT count(*) FROM source_repos),
     (SELECT count(*) FROM user_source_connections_legacy_v0_260606);`,
], 'pipe');

const expectedVerification = `${expectedHead}|3|3|0|0|0`;
if (verification !== expectedVerification) {
  console.error(`replay-schema-head-postgres · FAIL · expected ${expectedVerification}, received ${verification}`);
  process.exit(1);
}

console.log(`replay-schema-head-postgres · PASS · empty source replay reached schema ${expectedHead}; bridge tables 3/3 RLS-enabled and empty`);
