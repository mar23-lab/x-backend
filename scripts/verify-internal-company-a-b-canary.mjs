#!/usr/bin/env node
// verify-internal-company-a-b-canary.mjs
//
// Composed customer-zero verifier for the internal company A/B canary. This
// gate deliberately reuses maintained lower-level verifiers instead of
// inventing a separate fixture universe:
// - new user onboarding and tenant isolation
// - connector/token revocation contract
// - customer revocation behavior over allowed API/MCP surfaces
// - two-tenant readiness fixture
// - live canary packet lifecycle parity when scoped canary credentials exist

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_CANARY_ENV_FILE = path.join(
  os.homedir(),
  '.xlooop',
  'pilot-telemetry',
  'secrets',
  'xlooop-canary-api-token.env',
);

const ALLOWED_INTERNAL_CANARY_HOSTS = new Set([
  'api-test.xlooop.com',
  'xlooop-api-pilot-shadow.xlooop23.workers.dev',
]);

if (process.argv.includes('--self-test')) {
  runSelfTest();
}

const canaryConfig = loadCanaryConfigFromEnvFile(
  process.env.XLOOOP_CANARY_API_TOKEN_ENV_FILE || DEFAULT_CANARY_ENV_FILE,
);
const canaryTarget = assessCanaryTarget(process.env.XLOOOP_API_BASE || canaryConfig.apiBase);

const baseEnv = {
  ...process.env,
  XLOOOP_API_BASE: canaryTarget.apiBase,
  XLOOOP_PARITY_PACKET_ID: process.env.XLOOOP_PARITY_PACKET_ID || canaryConfig.packetId,
};

if (!baseEnv.XLOOOP_CANARY_API_TOKEN && canaryConfig.token) {
  baseEnv.XLOOOP_CANARY_API_TOKEN = canaryConfig.token;
}

const result = {
  schema_id: 'xlooop.internal_company_a_b_canary.verifier.v1',
  status: 'PASS',
  api_base: baseEnv.XLOOOP_API_BASE,
  packet_id: baseEnv.XLOOOP_PARITY_PACKET_ID,
  checks: [],
  failures: [],
  warnings: [],
};

if (!canaryTarget.ok) {
  result.status = 'FAIL';
  result.failures.push({
    id: 'internal_canary_target_policy',
    reason: canaryTarget.reason,
  });
  finish();
}

runCheck('new_user_api_mcp_onboarding_scenario', [
  'node',
  'scripts/verify-commercial-governance-hardening.mjs',
  '--check=new_user_api_mcp_onboarding_scenario',
]);
runCheck('connector_token_revocation_contract', [
  'node',
  'scripts/verify-commercial-governance-hardening.mjs',
  '--check=connector_token_revocation',
]);
runCheck('customer_revocation_authority', ['node', 'scripts/verify-customer-revocation-authority.mjs']);
runCheck('two_tenant_commercial_fixture', ['node', 'scripts/verify-two-tenant-commercial-pilot.mjs'], {
  allowWarnings: true,
});
runCheck('api_mcp_lifecycle_parity_live_read_only', [
  'node',
  'scripts/verify-api-mcp-lifecycle-parity.mjs',
  '--format=json',
  '--read-only',
]);

finish();

function loadCanaryConfigFromEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { apiBase: '', token: '', packetId: '' };
  const text = fs.readFileSync(filePath, 'utf8');
  const value = (name) => {
    const match = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}=(['"]?)([^'"\\n]+)\\1\\s*$`, 'm'));
    return match ? match[2].trim() : '';
  };
  return {
    apiBase: value('XLOOOP_API_BASE'),
    token: value('XLOOOP_CANARY_API_TOKEN'),
    packetId: value('XLOOOP_PARITY_PACKET_ID'),
  };
}

function assessCanaryTarget(rawApiBase) {
  const candidate = String(rawApiBase || '').trim();
  if (!candidate) {
    return {
      ok: false,
      apiBase: '',
      reason: 'XLOOOP_API_BASE is required; the internal company A/B canary never defaults to production',
    };
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, apiBase: candidate, reason: 'XLOOOP_API_BASE must be an absolute URL' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, apiBase: candidate, reason: 'internal company A/B canary requires HTTPS' };
  }
  if (url.username || url.password || url.search || url.hash) {
    return {
      ok: false,
      apiBase: candidate,
      reason: 'internal company A/B canary target cannot contain credentials, query parameters, or fragments',
    };
  }
  if (!ALLOWED_INTERNAL_CANARY_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      apiBase: candidate,
      reason: `internal company A/B canary target is not an approved pilot-shadow host: ${url.hostname}`,
    };
  }

  url.pathname = url.pathname.replace(/\/$/, '');
  return { ok: true, apiBase: url.toString().replace(/\/$/, ''), reason: null };
}

function runSelfTest() {
  const cases = [
    {
      id: 'missing_target_fails_closed',
      actual: assessCanaryTarget(''),
      expected: false,
    },
    {
      id: 'invalid_url_fails_closed',
      actual: assessCanaryTarget('not-a-url'),
      expected: false,
    },
    {
      id: 'plaintext_http_fails_closed',
      actual: assessCanaryTarget('http://api-test.xlooop.com'),
      expected: false,
    },
    {
      id: 'production_api_fails_closed',
      actual: assessCanaryTarget('https://api.xlooop.com'),
      expected: false,
    },
    {
      id: 'unknown_workers_host_fails_closed',
      actual: assessCanaryTarget('https://unapproved.workers.dev'),
      expected: false,
    },
    {
      id: 'pilot_workers_host_passes',
      actual: assessCanaryTarget('https://xlooop-api-pilot-shadow.xlooop23.workers.dev/'),
      expected: true,
    },
    {
      id: 'durable_pilot_domain_passes',
      actual: assessCanaryTarget('https://api-test.xlooop.com'),
      expected: true,
    },
  ].map((testCase) => ({
    id: testCase.id,
    status: testCase.actual.ok === testCase.expected ? 'PASS' : 'FAIL',
    expected_ok: testCase.expected,
    actual_ok: testCase.actual.ok,
    reason: testCase.actual.reason,
  }));
  const failures = cases.filter((testCase) => testCase.status === 'FAIL');
  console.log(JSON.stringify({
    schema_id: 'xlooop.internal_company_a_b_canary.target_policy.self_test.v1',
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks: cases,
    failures: failures.map((testCase) => testCase.id),
  }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

function runCheck(id, command, options = {}) {
  const child = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    env: baseEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const parsed = parseLastJson(child.stdout);
  const warningCount = Array.isArray(parsed?.warnings) ? parsed.warnings.length : 0;
  const status = child.status === 0 && parsed?.status !== 'FAIL' ? 'PASS' : 'FAIL';
  const check = {
    id,
    status,
    exit_code: child.status,
    command: command.join(' '),
    child_status: parsed?.status || null,
    warning_count: warningCount,
  };
  if (warningCount && options.allowWarnings) {
    check.status = 'PASS';
    check.warning_policy = 'allowed_structural_live_evidence_warning';
    result.warnings.push({
      id,
      message: 'child verifier emitted warnings; accepted for internal canary because live external-company evidence is tracked separately',
      warning_count: warningCount,
    });
  }
  if (status === 'FAIL') {
    check.stderr_tail = (child.stderr || '').slice(-1200);
    check.stdout_tail = (child.stdout || '').slice(-1800);
    result.status = 'FAIL';
    result.failures.push({ id, exit_code: child.status, child_status: parsed?.status || null });
  }
  result.checks.push(check);
}

function parseLastJson(text) {
  if (!text) return null;
  const start = text.lastIndexOf('\n{');
  const candidate = start >= 0 ? text.slice(start + 1) : text.slice(text.indexOf('{'));
  if (!candidate || !candidate.trim().startsWith('{')) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function finish() {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'PASS' ? 0 : 1);
}
