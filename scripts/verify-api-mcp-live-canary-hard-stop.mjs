#!/usr/bin/env node
// Composed hard-stop for API/MCP live lifecycle parity authority.
//
// Normal mode proves the safe posture: static contracts and customer-zero
// boundaries are wired, while live API/MCP parity authority remains absent
// unless real canary packet and token evidence is configured. Strict mode is
// the future production/live-canary promotion gate and fails closed unless the
// maintained live lifecycle verifier passes with scoped canary credentials.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const strictLive = process.argv.includes('--strict-live') || process.env.XLOOOP_REQUIRE_API_MCP_LIVE_CANARY === '1';
const packetId = process.env.XLOOOP_PARITY_PACKET_ID || '';
const readTokenFile = process.env.XLOOOP_CANARY_API_TOKEN_FILE || '/tmp/xlooop-canary-api-token.txt';
const lifecycleTokenFile = process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE || '/tmp/xlooop-canary-lifecycle-api-token.txt';
const hasReadToken = Boolean(process.env.XLOOOP_CANARY_API_TOKEN) || fs.existsSync(readTokenFile);
const hasLifecycleToken = Boolean(process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN) || fs.existsSync(lifecycleTokenFile);
const checks = [];
const failures = [];
const warnings = [];

function addCheck(id, ok, details = {}, options = {}) {
  const status = ok ? 'PASS' : (options.warnOnly ? 'WARN' : 'FAIL');
  const row = { id, status, ...details };
  checks.push(row);
  if (!ok && options.block) failures.push(row);
  if (!ok && options.warnOnly) warnings.push({ id, message: options.message || 'Evidence input is not configured.', ...details });
  return row;
}

function run(id, command, args, options = {}) {
  const proc = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 12,
    env: process.env,
  });
  const row = {
    id,
    status: proc.status === 0 ? 'PASS' : 'FAIL',
    exit_code: proc.status,
    required_for_live: options.requiredForLive === true,
    stdout_tail: (proc.stdout || '').slice(-1800),
    stderr_tail: (proc.stderr || '').slice(-1800),
  };
  try {
    const parsed = parseLastJson(proc.stdout || '');
    if (parsed) {
      row.summary = {
        schema_id: parsed.schema_id,
        status: parsed.status,
        mode: parsed.mode,
        packet_id: parsed.packet_id,
        failure_count: Array.isArray(parsed.failures) ? parsed.failures.length : undefined,
        warning_count: Array.isArray(parsed.warnings) ? parsed.warnings.length : undefined,
      };
    }
  } catch {
    // Keep raw tails for diagnostics.
  }
  checks.push(row);
  if (proc.status !== 0 && options.block) failures.push(row);
  if (proc.status !== 0 && options.requiredForLive) {
    warnings.push({
      id: `${id}_live_authority_absent`,
      message: options.message || 'Required API/MCP live-canary evidence is absent.',
    });
  }
  return row;
}

addCheck('canary_packet_id_configured', Boolean(packetId), {
  env: 'XLOOOP_PARITY_PACKET_ID',
  configured: Boolean(packetId),
  canary_prefixed: packetId.startsWith('pkt-canary-'),
}, { block: strictLive, warnOnly: !strictLive, message: 'Set XLOOOP_PARITY_PACKET_ID before claiming live API/MCP canary authority.' });
addCheck('canary_read_token_configured', hasReadToken, {
  env: 'XLOOOP_CANARY_API_TOKEN or XLOOOP_CANARY_API_TOKEN_FILE',
  token_source: process.env.XLOOOP_CANARY_API_TOKEN ? 'env' : (fs.existsSync(readTokenFile) ? readTokenFile : null),
}, { block: strictLive, warnOnly: !strictLive, message: 'Set XLOOOP_CANARY_API_TOKEN or XLOOOP_CANARY_API_TOKEN_FILE before claiming live API/MCP canary authority.' });
addCheck('canary_lifecycle_token_configured', hasLifecycleToken, {
  env: 'XLOOOP_CANARY_LIFECYCLE_API_TOKEN or XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE',
  token_source: process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN ? 'env' : (fs.existsSync(lifecycleTokenFile) ? lifecycleTokenFile : null),
}, { block: strictLive, warnOnly: !strictLive, message: 'Set XLOOOP_CANARY_LIFECYCLE_API_TOKEN or XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE before claiming live API/MCP canary authority.' });

run('static_mcp_api_lifecycle_contract', 'npm', ['run', '--silent', 'verify:mcp-api-lifecycle-parity-live'], {
  block: true,
});
run('customer_revocation_end_to_end', 'npm', ['run', '--silent', 'verify:customer-revocation-end-to-end'], {
  block: true,
});
run('api_mcp_lifecycle_parity_live', 'npm', ['run', '--silent', 'verify:api-mcp-lifecycle-parity', '--', '--format=json'], {
  block: strictLive,
  requiredForLive: true,
  message: 'Set XLOOOP_PARITY_PACKET_ID and scoped canary tokens before claiming live API/MCP lifecycle parity authority.',
});

const liveRun = checks.find((row) => row.id === 'api_mcp_lifecycle_parity_live');
const liveAuthority = strictLive && liveRun?.status === 'PASS' && Boolean(packetId) && hasReadToken && hasLifecycleToken;
if (strictLive && !liveAuthority) {
  failures.push({
    id: 'api_mcp_live_canary_authority_blocked',
    status: 'FAIL',
    message: 'API/MCP live-canary authority is blocked until packet id, read token, lifecycle token, and live verifier all pass.',
  });
}

const status = failures.length ? 'FAIL' : 'PASS';
const report = {
  schema_id: 'xlooop.api_mcp_live_canary_hard_stop.verifier.v1',
  status,
  strict_live: strictLive,
  api_mcp_live_canary_authority: liveAuthority,
  internal_static_boundary_authority: status === 'PASS' && liveAuthority === false,
  configured_inputs: {
    api_base: process.env.XLOOOP_API_BASE || 'https://api.xlooop.com',
    packet_id_configured: Boolean(packetId),
    packet_id_canary_prefixed: packetId.startsWith('pkt-canary-'),
    read_token_configured: hasReadToken,
    lifecycle_token_configured: hasLifecycleToken,
  },
  checks,
  failures,
  warnings,
  conclusion: liveAuthority
    ? 'API/MCP live lifecycle parity authority is present for the scoped canary lane.'
    : 'API/MCP static/customer-zero boundaries are wired, but live lifecycle parity authority remains blocked until scoped canary evidence is configured and passing.',
};

console.log(JSON.stringify(report, null, 2));
process.exit(status === 'PASS' ? 0 : 1);

function parseLastJson(text) {
  if (!text) return null;
  const start = text.lastIndexOf('\n{');
  const candidate = start >= 0 ? text.slice(start + 1) : text.slice(text.indexOf('{'));
  if (!candidate || !candidate.trim().startsWith('{')) return null;
  return JSON.parse(candidate);
}
