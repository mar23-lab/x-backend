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
const selfTest = process.argv.includes('--self-test');
const declaredTarget = parseArg('target') || process.env.XLOOOP_CANARY_TARGET || '';
const requestedApiBase = parseArg('api-base') || process.env.XLOOOP_API_BASE || '';
const targetContract = resolveCanaryTarget({
  declaredTarget,
  requestedApiBase,
  strictLive,
});

if (selfTest) {
  runSelfTest();
  process.exit(0);
}

const packetId = process.env.XLOOOP_PARITY_PACKET_ID || '';
const readTokenFile = process.env.XLOOOP_CANARY_API_TOKEN_FILE || '/tmp/xlooop-canary-api-token.txt';
const lifecycleTokenFile = process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE || '/tmp/xlooop-canary-lifecycle-api-token.txt';
const hasReadToken = Boolean(process.env.XLOOOP_CANARY_API_TOKEN) || fs.existsSync(readTokenFile);
const hasLifecycleToken = Boolean(process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN) || fs.existsSync(lifecycleTokenFile);
const checks = [];
const failures = [];
const warnings = [];
const childEnv = {
  ...process.env,
  XLOOOP_API_BASE: targetContract.apiBase,
  ...(targetContract.target ? { XLOOOP_CANARY_TARGET: targetContract.target } : {}),
};

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
    env: childEnv,
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

addCheck('canary_target_declared', targetContract.declared, {
  argument: '--target=production|pilot-shadow',
  target: targetContract.target || null,
}, {
  block: strictLive,
  warnOnly: !strictLive,
  message: 'Strict live canaries require an explicit --target or XLOOOP_CANARY_TARGET.',
});
addCheck('canary_target_api_base_match', targetContract.ok, {
  target: targetContract.target || null,
  api_base: targetContract.apiBase,
  expected_api_base: targetContract.expectedApiBase,
  reason: targetContract.reason || null,
}, {
  block: true,
});

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
run('customer_revocation_authority', 'npm', ['run', '--silent', 'verify:customer-revocation-authority'], {
  block: true,
});
// No live network execution is allowed without an explicit named target, even
// in advisory mode. Advisory compatibility may still resolve a default for
// reporting, but it must never turn omission into a production request.
if (shouldRunLiveCanary(targetContract)) {
  run('api_mcp_lifecycle_parity_live', 'npm', ['run', '--silent', 'verify:api-mcp-lifecycle-parity', '--', '--format=json'], {
    block: strictLive,
    requiredForLive: true,
    message: 'Set XLOOOP_PARITY_PACKET_ID and scoped canary tokens before claiming live API/MCP lifecycle parity authority.',
  });
} else {
  checks.push({
    id: 'api_mcp_lifecycle_parity_live',
    status: 'SKIP',
    required_for_live: true,
    reason: 'target_contract_invalid_live_execution_refused',
  });
}

const liveRun = checks.find((row) => row.id === 'api_mcp_lifecycle_parity_live');
const liveAuthority = strictLive
  && targetContract.declared
  && targetContract.ok
  && liveRun?.status === 'PASS'
  && Boolean(packetId)
  && hasReadToken
  && hasLifecycleToken;
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
    target: targetContract.target || null,
    target_declared: targetContract.declared,
    api_base: targetContract.apiBase,
    expected_api_base: targetContract.expectedApiBase,
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

function parseArg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : '';
}

function normalizeApiBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return raw;
  }
}

function resolveCanaryTarget({ declaredTarget: targetInput, requestedApiBase: apiInput, strictLive: strict }) {
  const targets = {
    production: 'https://api.xlooop.com',
    'pilot-shadow': 'https://xlooop-api-pilot-shadow.xlooop23.workers.dev',
  };
  const declared = Boolean(String(targetInput || '').trim());
  const target = String(targetInput || '').trim().toLowerCase();
  if (declared && !Object.hasOwn(targets, target)) {
    return {
      ok: false,
      declared,
      target,
      apiBase: normalizeApiBase(apiInput),
      expectedApiBase: null,
      reason: 'unknown_canary_target',
    };
  }
  if (strict && !declared) {
    return {
      ok: false,
      declared,
      target: '',
      apiBase: normalizeApiBase(apiInput || targets.production),
      expectedApiBase: null,
      reason: 'strict_live_target_missing',
    };
  }
  const effectiveTarget = target || 'production';
  const expectedApiBase = targets[effectiveTarget];
  const apiBase = normalizeApiBase(apiInput || expectedApiBase);
  return {
    ok: apiBase === expectedApiBase,
    declared,
    target: effectiveTarget,
    apiBase,
    expectedApiBase,
    reason: apiBase === expectedApiBase ? '' : 'canary_target_api_base_mismatch',
  };
}

function shouldRunLiveCanary(contract) {
  return contract.ok === true && contract.declared === true;
}

function runSelfTest() {
  const cases = [
    ['production canonical', { declaredTarget: 'production', requestedApiBase: '', strictLive: true }, true],
    ['pilot-shadow canonical', { declaredTarget: 'pilot-shadow', requestedApiBase: '', strictLive: true }, true],
    ['pilot-shadow refuses production', { declaredTarget: 'pilot-shadow', requestedApiBase: 'https://api.xlooop.com', strictLive: true }, false],
    ['production refuses pilot-shadow', { declaredTarget: 'production', requestedApiBase: 'https://xlooop-api-pilot-shadow.xlooop23.workers.dev', strictLive: true }, false],
    ['strict target required', { declaredTarget: '', requestedApiBase: 'https://api.xlooop.com', strictLive: true }, false],
    ['unknown target refused', { declaredTarget: 'staging-ish', requestedApiBase: '', strictLive: true }, false],
    ['non-strict compatibility', { declaredTarget: '', requestedApiBase: '', strictLive: false }, true],
  ];
  const failures = cases
    .map(([name, input, expected]) => ({ name, actual: resolveCanaryTarget(input).ok, expected }))
    .filter((row) => row.actual !== row.expected);
  const undeclaredAdvisory = resolveCanaryTarget({
    declaredTarget: '',
    requestedApiBase: '',
    strictLive: false,
  });
  if (undeclaredAdvisory.declared || !undeclaredAdvisory.ok) {
    failures.push({
      name: 'advisory compatibility stays reportable but undeclared',
      actual: undeclaredAdvisory,
      expected: { declared: false, ok: true },
    });
  }
  if (shouldRunLiveCanary(undeclaredAdvisory)) {
    failures.push({
      name: 'undeclared advisory target never executes live',
      actual: true,
      expected: false,
    });
  }
  const declaredPilot = resolveCanaryTarget({
    declaredTarget: 'pilot-shadow',
    requestedApiBase: '',
    strictLive: false,
  });
  if (!shouldRunLiveCanary(declaredPilot)) {
    failures.push({
      name: 'declared valid pilot target executes live',
      actual: false,
      expected: true,
    });
  }
  console.log(JSON.stringify({
    schema_id: 'xlooop.api_mcp_live_canary_target_contract.self_test.v1',
    status: failures.length ? 'FAIL' : 'PASS',
    check_count: cases.length + 3,
    failures,
  }, null, 2));
  if (failures.length) process.exit(1);
}
