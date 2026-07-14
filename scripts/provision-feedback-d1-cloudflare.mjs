#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migrationFiles = [
  'migrations/0001_feedback_annotations.sql',
  'migrations/0002_customer_feedback_authority.sql',
  'migrations/0003_paid_pilot_authority.sql',
];
const migrationSql = migrationFiles
  .map((file) => fs.readFileSync(path.join(repoRoot, file), 'utf8'))
  .join('\n\n');

const envArg = readArg('env') || 'both';
const dryRun = hasArg('dry-run');
const environments = envArg === 'both' ? ['dev', 'test'] : [envArg];
if (!environments.every((env) => ['dev', 'test'].includes(env))) {
  fail('Use --env=dev, --env=test, or --env=both');
}

const token = process.env.CLOUDFLARE_API_TOKEN || (dryRun ? 'dry-run-token' : '');
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (dryRun ? 'dry-run-account' : '');
if (!token) fail('CLOUDFLARE_API_TOKEN is required');
if (!accountId) fail('CLOUDFLARE_ACCOUNT_ID is required');

const projectNames = {
  dev: process.env.CLOUDFLARE_PAGES_PROJECT_XLOOOP_DEV || (dryRun ? 'xlooop-dev' : ''),
  test: process.env.CLOUDFLARE_PAGES_PROJECT_XLOOOP_TEST || (dryRun ? 'xlooop-test' : ''),
};

for (const environment of environments) {
  if (!projectNames[environment]) fail(`CLOUDFLARE_PAGES_PROJECT_XLOOOP_${environment.toUpperCase()} is required`);
}

const results = [];

for (const environment of environments) {
  const databaseName = `xlooop-feedback-${environment}`;
  const projectName = projectNames[environment];
  const database = await ensureD1Database(databaseName);
  await runMigration(database);
  await bindPagesProject(projectName, database, environment);
  results.push({
    environment,
    project_name: projectName,
    binding: 'FEEDBACK_DB',
    database_name: database.name,
    database_id: database.uuid,
    require_access: true,
    migrations: migrationFiles,
    dry_run: dryRun,
  });
}

console.log(JSON.stringify({
  status: dryRun ? 'dry_run' : 'configured',
  schema_version: 'xlooop.feedback_d1_provisioning.v1',
  results,
}, null, 2));

async function ensureD1Database(name) {
  if (dryRun) return { name, uuid: 'dry-run-database-id' };
  const existing = await listD1Databases();
  const matched = existing.find((db) => db.name === name);
  if (matched) return normalizeDatabase(matched);
  const created = await cloudflare(`/accounts/${accountId}/d1/database`, {
    method: 'POST',
    body: { name },
  });
  return normalizeDatabase(created.result);
}

async function listD1Databases() {
  const rows = [];
  let page = 1;
  while (page < 20) {
    const res = await cloudflare(`/accounts/${accountId}/d1/database?page=${page}&per_page=100`);
    rows.push(...(res.result || []));
    const info = res.result_info || {};
    if (!info.total_pages || page >= info.total_pages) break;
    page += 1;
  }
  return rows;
}

async function runMigration(database) {
  if (dryRun) return;
  const statements = migrationSql
    .split(/;\s*(?:\n|$)/)
    .map((sql) => sql.trim())
    .filter(Boolean);
  for (const sql of statements) {
    await cloudflare(`/accounts/${accountId}/d1/database/${database.uuid}/query`, {
      method: 'POST',
      body: { sql },
    });
  }
}

async function bindPagesProject(projectName, database, environment) {
  if (dryRun) return;
  const project = await cloudflare(`/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`);
  const existing = project.result || {};
  const configs = existing.deployment_configs || {};
  const updatedConfigs = {
    production: withFeedbackBinding(configs.production || {}, database, environment),
    preview: withFeedbackBinding(configs.preview || {}, database, environment),
  };
  await cloudflare(`/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`, {
    method: 'PATCH',
    body: { deployment_configs: updatedConfigs },
  });
}

function withFeedbackBinding(config, database, environment) {
  const d1 = { ...(config.d1_databases || {}) };
  d1.FEEDBACK_DB = { id: database.uuid };
  const envVars = { ...(config.env_vars || {}) };
  envVars.FEEDBACK_REQUIRE_ACCESS = { type: 'plain_text', value: '1' };
  envVars.XLOOOP_FEEDBACK_ENVIRONMENT = { type: 'plain_text', value: environment };
  return {
    ...config,
    d1_databases: d1,
    env_vars: envVars,
    fail_open: false,
  };
}

async function cloudflare(pathname, options = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.success === false) {
    throw new Error(`Cloudflare API failed ${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload.errors || payload)}`);
  }
  return payload;
}

function normalizeDatabase(db) {
  const uuid = db.uuid || db.id || db.database_id;
  if (!db?.name || !uuid) fail(`Unexpected D1 database payload: ${JSON.stringify(db)}`);
  return { ...db, uuid };
}

function readArg(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

function fail(message) {
  console.error(`provision-feedback-d1-cloudflare: FAIL - ${message}`);
  process.exit(1);
}
