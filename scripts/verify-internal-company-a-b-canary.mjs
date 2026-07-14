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
const DEFAULT_PACKET_ID = 'pkt-canary-api-mcp-parity-20260619t080834z';
const DEFAULT_CANARY_ENV_FILE = path.join(
  os.homedir(),
  '.xlooop',
  'pilot-telemetry',
  'secrets',
  'xlooop-canary-api-token.env',
);

const baseEnv = {
  ...process.env,
  XLOOOP_API_BASE: process.env.XLOOOP_API_BASE || 'https://api.xlooop.com',
  XLOOOP_PARITY_PACKET_ID: process.env.XLOOOP_PARITY_PACKET_ID || DEFAULT_PACKET_ID,
};

const tokenFromEnvFile = loadTokenFromEnvFile(process.env.XLOOOP_CANARY_API_TOKEN_ENV_FILE || DEFAULT_CANARY_ENV_FILE);
if (!baseEnv.XLOOOP_CANARY_API_TOKEN && tokenFromEnvFile) {
  baseEnv.XLOOOP_CANARY_API_TOKEN = tokenFromEnvFile;
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
runCheck('customer_revocation_end_to_end', ['node', 'scripts/verify-customer-revocation-end-to-end.mjs']);
runCheck('two_tenant_commercial_fixture', ['node', 'scripts/verify-two-tenant-commercial-pilot.mjs'], {
  allowWarnings: true,
});
runCheck('api_mcp_lifecycle_parity_live', ['node', 'scripts/verify-api-mcp-lifecycle-parity.mjs', '--format=json']);

finish();

function loadTokenFromEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  const text = fs.readFileSync(filePath, 'utf8');
  const match = text.match(/^\s*(?:export\s+)?XLOOOP_CANARY_API_TOKEN=(['"]?)([^'"\n]+)\1\s*$/m);
  return match ? match[2].trim() : '';
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
