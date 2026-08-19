#!/usr/bin/env node
// Resolve production Neon role credentials just-in-time and run a governed
// authority verifier without persisting or printing connection strings.

import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const DEFAULT_PROFILE = Object.freeze({
  project_id: 'flat-truth-23350426',
  branch_id: 'br-dark-credit-a7tb4yhu',
  host: 'ep-square-frost-a7rohpxg-pooler.ap-southeast-2.aws.neon.tech',
  database: 'neondb',
  owner_role: 'neondb_owner',
  app_role: 'xlooop_app',
});

const API_BASE = 'https://console.neon.tech/api/v2';
const OAUTH_HOST = 'https://oauth2.neon.tech';
const OAUTH_CLIENT_ID = 'neonctl';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const SELF_TEST = process.argv.includes('--self-test');
const TARGET = argumentValue('--target') || 'production-db';
const ALLOWED_TARGETS = Object.freeze({
  'production-db': ['run', '--silent', 'verify:production-db-live-authority', '--', '--strict-live-db'],
  'live-evidence-matrix': ['run', '--silent', 'verify:live-evidence-authority-matrix', '--', '--strict-live-authority'],
  'public-readiness': ['run', '--silent', 'verify:public-production-readiness-hard-stop', '--', '--strict-public'],
});

if (SELF_TEST) {
  await runSelfTest();
  process.exit(0);
}

assertSupportedNode();

if (!Object.hasOwn(ALLOWED_TARGETS, TARGET)) {
  fail(`Unsupported target ${JSON.stringify(TARGET)}. Allowed targets: ${Object.keys(ALLOWED_TARGETS).join(', ')}`);
}

const profile = resolveProfile(process.env);
const credentialsPath = process.env.XLOOOP_NEON_CREDENTIALS_FILE || join(homedir(), '.config', 'neonctl', 'credentials.json');
const accessToken = await resolveAccessToken(credentialsPath);

const ownerPassword = await revealPassword(accessToken, profile, profile.owner_role);
const appPassword = await revealPassword(accessToken, profile, profile.app_role);
const ownerDsn = buildDsn(profile, profile.owner_role, ownerPassword);
const appDsn = buildDsn(profile, profile.app_role, appPassword);
const secrets = [ownerPassword, appPassword, ownerDsn, appDsn, accessToken];

const result = spawnSync(npmCommand(), ALLOWED_TARGETS[TARGET], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 24,
  env: {
    ...process.env,
    DATABASE_URL: ownerDsn,
    XLOOOP_RLS_APP_DATABASE_URL: appDsn,
    XLOOOP_REQUIRE_PRODUCTION_DB_AUTHORITY: '1',
  },
});

const stdout = redact(result.stdout || '', secrets);
const stderr = redact(result.stderr || '', secrets);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
if (result.error) fail(`Unable to execute ${TARGET}: ${redact(result.error.message, secrets)}`);
process.exit(result.status ?? 1);

function resolveProfile(env) {
  const profile = {
    project_id: env.XLOOOP_NEON_PROJECT_ID || DEFAULT_PROFILE.project_id,
    branch_id: env.XLOOOP_NEON_PRODUCTION_BRANCH_ID || DEFAULT_PROFILE.branch_id,
    host: env.XLOOOP_NEON_PRODUCTION_HOST || DEFAULT_PROFILE.host,
    database: env.XLOOOP_NEON_PRODUCTION_DATABASE || DEFAULT_PROFILE.database,
    owner_role: env.XLOOOP_NEON_OWNER_ROLE || DEFAULT_PROFILE.owner_role,
    app_role: env.XLOOOP_NEON_APP_ROLE || DEFAULT_PROFILE.app_role,
  };
  for (const [key, value] of Object.entries(profile)) {
    if (!value || /[\s/@]/.test(value)) fail(`Invalid production DB authority profile field: ${key}`);
  }
  if (!/\.neon\.tech$/.test(profile.host)) fail('Production DB authority profile host must be a Neon hostname.');
  return profile;
}

async function resolveAccessToken(path) {
  const environmentToken = process.env.NEON_API_KEY || process.env.XLOOOP_NEON_API_TOKEN;
  if (environmentToken) return environmentToken;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`Neon credential profile is unavailable at ${path}. Run neonctl auth before this verifier.`);
  }
  if (!credentialNeedsRefresh(parsed)) return parsed.access_token;
  if (!parsed?.refresh_token || typeof parsed.refresh_token !== 'string') {
    fail('Neon OAuth credential is expired and has no refresh token. Run neonctl auth before this verifier.');
  }
  const refreshed = await refreshOAuthCredential(parsed);
  persistCredentialSet(path, refreshed);
  return refreshed.access_token;
}

function credentialNeedsRefresh(credentials, now = Date.now()) {
  return typeof credentials?.access_token !== 'string'
    || !credentials.access_token
    || !Number.isFinite(credentials?.expires_at)
    || credentials.expires_at <= now + TOKEN_REFRESH_SKEW_MS;
}

async function refreshOAuthCredential(credentials, fetchImpl = fetch) {
  let discoveryResponse;
  try {
    discoveryResponse = await fetchImpl(`${OAUTH_HOST}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`Neon OAuth discovery failed: ${error?.name || 'network_error'}`);
  }
  const discovery = await discoveryResponse.json().catch(() => ({}));
  if (!discoveryResponse.ok || typeof discovery.token_endpoint !== 'string') {
    fail(`Neon OAuth discovery failed: HTTP ${discoveryResponse.status}`);
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refresh_token,
    client_id: OAUTH_CLIENT_ID,
  });
  let tokenResponse;
  try {
    tokenResponse = await fetchImpl(discovery.token_endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`Neon OAuth refresh failed: ${error?.name || 'network_error'}`);
  }
  const tokenSet = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || typeof tokenSet.access_token !== 'string' || !tokenSet.access_token) {
    fail(`Neon OAuth refresh failed: HTTP ${tokenResponse.status}. Run neonctl auth before this verifier.`);
  }
  return mergeTokenSet(credentials, tokenSet);
}

function mergeTokenSet(previous, refreshed, now = Date.now()) {
  const expiresIn = Number.isFinite(refreshed.expires_in) ? refreshed.expires_in : 0;
  return {
    ...previous,
    ...refreshed,
    refresh_token: refreshed.refresh_token || previous.refresh_token,
    expires_at: now + expiresIn * 1000,
  };
}

function persistCredentialSet(path, credentials) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch {
    fail(`Neon OAuth credential refreshed but could not be persisted safely at ${path}.`);
  }
}

async function revealPassword(accessToken, profile, role) {
  const url = `${API_BASE}/projects/${encodeURIComponent(profile.project_id)}/branches/${encodeURIComponent(profile.branch_id)}/roles/${encodeURIComponent(role)}/reveal_password`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`Neon credential resolution failed for role ${role}: ${error?.name || 'network_error'}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(`Neon credential resolution failed for role ${role}: HTTP ${response.status}`);
  const password = findPassword(body);
  if (!password) fail(`Neon credential resolution returned no password for role ${role}.`);
  return password;
}

function findPassword(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.password === 'string' && value.password) return value.password;
  for (const child of Object.values(value)) {
    const found = findPassword(child);
    if (found) return found;
  }
  return null;
}

function buildDsn(profile, role, password) {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${profile.host}/${encodeURIComponent(profile.database)}?channel_binding=require&sslmode=require`;
}

function redact(value, secrets) {
  let result = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[REDACTED]');
    result = result.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return result.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_DATABASE_URL]');
}

function argumentValue(name) {
  const exact = process.argv.filter((arg) => arg.startsWith(`${name}=`)).at(-1);
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function assertSupportedNode() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major !== 22) fail(`Node 22 is required by package.json; current runtime is ${process.version}.`);
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function fail(message) {
  console.error(`FAIL production DB authority profile: ${message}`);
  process.exit(1);
}

async function runSelfTest() {
  const synthetic = resolveProfile({});
  const nested = findPassword({ role: { password: 'synthetic-password' } });
  const dsn = buildDsn(synthetic, synthetic.app_role, 'p@ss/word');
  const redacted = redact(`token=abc ${dsn} p@ss/word`, ['abc', 'p@ss/word', dsn]);
  const now = Date.now();
  const currentCredential = { access_token: 'current', expires_at: now + 120_000 };
  const expiringCredential = { access_token: 'expiring', expires_at: now + 30_000 };
  const mergedCredential = mergeTokenSet(
    { refresh_token: 'preserved-refresh' },
    { access_token: 'next-access', expires_in: 3600 },
    now,
  );
  let fetchCall = 0;
  const refreshedCredential = await refreshOAuthCredential(
    { access_token: 'stale-access', refresh_token: 'synthetic-refresh', expires_at: now - 1 },
    async () => {
      fetchCall += 1;
      if (fetchCall === 1) {
        return new Response(JSON.stringify({ token_endpoint: 'https://oauth.example/token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ access_token: 'refreshed-access', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
  const tempDirectory = mkdtempSync(join(tmpdir(), 'xlooop-neon-profile-self-test-'));
  const tempCredentialPath = join(tempDirectory, 'credentials.json');
  persistCredentialSet(tempCredentialPath, refreshedCredential);
  const persistedCredential = JSON.parse(readFileSync(tempCredentialPath, 'utf8'));
  const persistedMode = statSync(tempCredentialPath).mode & 0o777;
  rmSync(tempDirectory, { recursive: true, force: true });
  const failures = [];
  if (nested !== 'synthetic-password') failures.push('nested password resolution');
  if (!dsn.includes('p%40ss%2Fword')) failures.push('DSN credential encoding');
  if (/abc|p@ss|postgresql:\/\//.test(redacted)) failures.push('secret redaction');
  if (credentialNeedsRefresh(currentCredential, now)) failures.push('current OAuth credential classified stale');
  if (!credentialNeedsRefresh(expiringCredential, now)) failures.push('expiry skew not enforced');
  if (mergedCredential.refresh_token !== 'preserved-refresh') failures.push('refresh-token rotation fallback');
  if (mergedCredential.expires_at !== now + 3_600_000) failures.push('refreshed expiry calculation');
  if (fetchCall !== 2 || refreshedCredential.access_token !== 'refreshed-access') failures.push('OAuth refresh exchange');
  if (persistedCredential.refresh_token !== 'synthetic-refresh') failures.push('refreshed credential persistence');
  if (persistedMode !== 0o600) failures.push('credential file mode');
  if (!Object.hasOwn(ALLOWED_TARGETS, 'public-readiness')) failures.push('public readiness target');
  if (failures.length) {
    console.error(JSON.stringify({ status: 'FAIL', failures }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    schema_id: 'xlooop.production_db_authority_profile.self_test.v1',
    status: 'PASS',
    profile_contains_secret_values: false,
    supported_targets: Object.keys(ALLOWED_TARGETS),
    redaction_verified: true,
  }, null, 2));
}
