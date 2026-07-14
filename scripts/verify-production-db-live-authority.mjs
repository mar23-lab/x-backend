#!/usr/bin/env node
// Central hard-stop for production database authority.
//
// Normal mode is an honest internal-validation posture: static RLS must pass,
// while live production authority remains false unless real DB URLs are present.
// Strict mode fails closed until production migrations and non-owner app-role
// RLS checks both pass against the target database.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const strict =
  process.argv.includes('--strict-live-db') ||
  process.env.XLOOOP_REQUIRE_PRODUCTION_DB_AUTHORITY === '1';

const checks = [];
const failures = [];
const warnings = [];

const envPresence = {
  DATABASE_URL: Boolean(process.env.DATABASE_URL),
  XLOOOP_RLS_APP_DATABASE_URL: Boolean(process.env.XLOOOP_RLS_APP_DATABASE_URL || process.env.APP_DATABASE_URL),
};

function run(id, command, args, options = {}) {
  const proc = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 12,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
  const parsed = parseLastJson(proc.stdout || '');
  const row = {
    id,
    status: proc.status === 0 ? 'PASS' : 'FAIL',
    exit_code: proc.status,
    required_for_production_db_authority: options.required === true,
    stdout_tail: (proc.stdout || '').slice(-1800),
    stderr_tail: (proc.stderr || '').slice(-1800),
    summary: parsed
      ? {
          schema_id: parsed.schema_id,
          status: parsed.status,
          ok: parsed.ok,
          migration_files: parsed.migration_files,
          recorded_applied: parsed.recorded_applied,
          missing_count: Array.isArray(parsed.missing) ? parsed.missing.length : undefined,
          static_checks: parsed.static_checks,
          live_checks: parsed.live_checks,
          app_role_checks: parsed.app_role_checks,
          failure_count: Array.isArray(parsed.failures) ? parsed.failures.length : undefined,
          warning_count: Array.isArray(parsed.warnings) ? parsed.warnings.length : undefined,
        }
      : null,
  };
  checks.push(row);
  if (proc.status !== 0 && options.blockInternal) failures.push(row);
  if (proc.status !== 0 && options.required) {
    const warning = {
      id: `${id}_authority_absent`,
      message: options.message || 'Production database live authority evidence is absent.',
      env_requirements: options.envRequirements || [],
    };
    warnings.push(warning);
    if (strict) failures.push({ ...row, message: warning.message });
  }
  return row;
}

if (!envPresence.DATABASE_URL) {
  const warning = {
    id: 'database_url_missing',
    message: 'DATABASE_URL is required to prove production migration state.',
    env_requirements: ['DATABASE_URL'],
  };
  warnings.push(warning);
  if (strict) failures.push({ id: warning.id, status: 'FAIL', message: warning.message });
}

if (!envPresence.XLOOOP_RLS_APP_DATABASE_URL) {
  const warning = {
    id: 'rls_app_database_url_missing',
    message: 'XLOOOP_RLS_APP_DATABASE_URL is required to prove non-owner app-role RLS enforcement.',
    env_requirements: ['XLOOOP_RLS_APP_DATABASE_URL'],
  };
  warnings.push(warning);
  if (strict) failures.push({ id: warning.id, status: 'FAIL', message: warning.message });
}

run('postgres_rls_phase2_static', 'npm', ['run', '--silent', 'verify:postgres-rls-phase2'], {
  blockInternal: true,
});

if (envPresence.DATABASE_URL || strict) {
  run('prod_migrations_live', 'npm', ['run', '--silent', 'verify:prod-migrations', '--', '--json'], {
    required: true,
    envRequirements: ['DATABASE_URL'],
    message: 'Production migration authority requires DATABASE_URL and every migration recorded in workers_schema_version.',
  });
}

if (envPresence.XLOOOP_RLS_APP_DATABASE_URL || strict) {
  run('postgres_rls_app_role_live', 'npm', ['run', '--silent', 'verify:postgres-rls-app-role'], {
    required: true,
    envRequirements: ['XLOOOP_RLS_APP_DATABASE_URL'],
    message: 'Production RLS authority requires a non-owner app-role database URL and app-role RLS verification.',
  });
}

const staticOk = checks.find((row) => row.id === 'postgres_rls_phase2_static')?.status === 'PASS';
const migrationsOk = checks.find((row) => row.id === 'prod_migrations_live')?.status === 'PASS';
const appRoleOk = checks.find((row) => row.id === 'postgres_rls_app_role_live')?.status === 'PASS';
const productionDbLiveAuthority = staticOk && migrationsOk && appRoleOk;

if (strict && !productionDbLiveAuthority) {
  failures.push({
    id: 'production_db_live_authority_blocked',
    status: 'FAIL',
    message: 'Production DB authority is blocked until static RLS, prod migrations, and app-role RLS all pass.',
  });
}

const status = failures.length ? 'FAIL' : 'PASS';
const report = {
  schema_id: 'xlooop.production_db_live_authority.verifier.v1',
  status,
  strict_live_db: strict,
  production_db_live_authority: productionDbLiveAuthority,
  internal_static_db_authority: status === 'PASS' && staticOk === true && productionDbLiveAuthority === false,
  configured_inputs: envPresence,
  checks,
  failures,
  warnings,
  conclusion: productionDbLiveAuthority
    ? 'Production DB migration and app-role RLS authority are present.'
    : 'Static DB/RLS posture is safe for internal validation, but production DB live authority remains blocked until DATABASE_URL and XLOOOP_RLS_APP_DATABASE_URL checks pass.',
};

console.log(JSON.stringify(report, null, 2));
process.exit(status === 'PASS' ? 0 : 1);

function parseLastJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to tail extraction for mixed human + JSON output.
    }
  }
  const start = text.lastIndexOf('\n{');
  const candidate = start >= 0 ? text.slice(start + 1) : text.slice(text.indexOf('{'));
  if (!candidate || !candidate.trim().startsWith('{')) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
