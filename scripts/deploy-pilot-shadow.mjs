#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  localMigrationHead,
  readCandidateDeploymentContract,
} from './lib/candidate-deployment-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'wrangler.pilot-shadow.toml';
const API_BASE = 'https://api-test.xlooop.com';
const WORKER = 'xlooop-api-pilot-shadow';
const EXPECTED_SELF_TEST_CHECKS = 8;
const REQUIRED_SECRETS = [
  'DATABASE_URL',
  'CUSTOMER_AUTO_PROVISION_APPROVER_USER_ID',
  'MODEL_RUNTIME_ACTIVE_KEY_ID',
  'MODEL_RUNTIME_ENC_KEYS',
  'XLOOOP_RLS_APP_DATABASE_URL',
];
const PREFLIGHT_SCRIPTS = [
  ['scripts/verify-pilot-shadow-config.mjs', 'pilot-shadow config verifier'],
  ['scripts/verify-pilot-shadow-database-role-contract.mjs', 'pilot-shadow database role contract'],
  ['scripts/verify-workers-ai-model-authority.mjs', 'Workers AI model authority'],
];

function fail(message) {
  throw new Error(`deploy-pilot-shadow · FAIL-CLOSED · ${message}`);
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    fail(`${options.label || command} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

export function assessPilotShadowHealth(health, expected) {
  const problems = [];
  if (health?.status !== 'ok') problems.push('status');
  if (health?.build !== expected.build) problems.push('build');
  if (health?.built_at !== expected.builtAt) problems.push('built_at');
  if (health?.environment !== 'pilot-shadow') problems.push('environment');
  if (health?.authority !== 'shadow') problems.push('authority');
  if (health?.schema_head !== expected.schemaHead) problems.push('schema_head');
  if (health?.contract_hash !== expected.contractHash) problems.push('contract_hash');
  if (health?.bindings?.model_runtime_keyring !== true) problems.push('model_runtime_keyring');
  return problems;
}

async function readHealth(expected) {
  let lastProblem = 'no response';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}/api/v1/health?ratify=${Date.now()}`, {
        headers: { 'Cache-Control': 'no-cache' },
      });
      const body = await response.json();
      const problems = assessPilotShadowHealth(body, expected);
      if (response.ok && problems.length === 0) return body;
      lastProblem = `${response.status}:${problems.join(',')}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  fail(`live health ratification did not converge: ${lastProblem}`);
}

function selfTest() {
  const expected = {
    build: 'a'.repeat(40),
    builtAt: '20260810T000000Z',
    schemaHead: 100,
    contractHash: 'b'.repeat(64),
  };
  const valid = {
    status: 'ok',
    build: expected.build,
    built_at: expected.builtAt,
    environment: 'pilot-shadow',
    authority: 'shadow',
    schema_head: 100,
    contract_hash: expected.contractHash,
    bindings: { model_runtime_keyring: true },
  };
  const checks = [
    ['exact pilot health passes', assessPilotShadowHealth(valid, expected).length === 0],
    ['stale build fails', assessPilotShadowHealth({ ...valid, build: 'c'.repeat(40) }, expected).includes('build')],
    ['production authority fails', assessPilotShadowHealth({ ...valid, authority: 'production' }, expected).includes('authority')],
    ['missing keyring fails', assessPilotShadowHealth({ ...valid, bindings: {} }, expected).includes('model_runtime_keyring')],
    ['durable pilot API domain is the deploy and health authority', API_BASE === 'https://api-test.xlooop.com'],
    ['pilot deploy verifies owner and RLS database roles before Wrangler',
      PREFLIGHT_SCRIPTS.some(([script]) => script === 'scripts/verify-pilot-shadow-database-role-contract.mjs')],
    ['pilot deploy verifies the Workers AI model authority before Wrangler',
      PREFLIGHT_SCRIPTS.some(([script]) => script === 'scripts/verify-workers-ai-model-authority.mjs')],
    ['pilot deploy requires an audited onboarding approver binding',
      REQUIRED_SECRETS.includes('CUSTOMER_AUTO_PROVISION_APPROVER_USER_ID')],
  ];
  if (checks.length !== EXPECTED_SELF_TEST_CHECKS) {
    fail(`self-test registered ${checks.length} checks; expected ${EXPECTED_SELF_TEST_CHECKS}`);
  }
  const failures = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failures.length) fail(`self-test: ${failures.join(',')}`);
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`deploy-pilot-shadow self-test PASS ${passed}/${EXPECTED_SELF_TEST_CHECKS}`);
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const approvalRef = String(process.env.XLOOOP_PILOT_SHADOW_DEPLOY_APPROVAL_REF || '').trim();
  if (!approvalRef) fail('XLOOOP_PILOT_SHADOW_DEPLOY_APPROVAL_REF is required');

  const dirty = git('status', '--porcelain=v1', '--untracked-files=all');
  if (dirty) fail('deployment requires a clean backend worktree');
  const head = git('rev-parse', 'HEAD');
  const remoteMain = git('ls-remote', 'origin', '-h', 'refs/heads/main').split('\t')[0];
  if (head !== remoteMain) fail(`HEAD ${head} does not equal origin/main ${remoteMain}`);

  const candidate = readCandidateDeploymentContract(ROOT, {
    ...process.env,
    XLOOOP_SCHEMA_HEAD: String(localMigrationHead(ROOT)),
    XLOOOP_DEPLOYMENT_WRANGLER_CONFIG: CONFIG,
  });
  if (candidate.worker_name !== WORKER || candidate.api_base !== API_BASE
    || candidate.environment !== 'pilot-shadow' || candidate.authority !== 'shadow') {
    fail('candidate deployment contract is not the isolated pilot-shadow target');
  }
  const contract = JSON.parse(readFileSync(path.join(ROOT, 'docs/contracts/api-contract.v1.json'), 'utf8'));
  for (const [script, label] of PREFLIGHT_SCRIPTS) {
    run(process.execPath, [script], { label });
  }

  const wrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const secretOutput = run(process.execPath, [wrangler, 'secret', 'list', '--config', CONFIG], {
    capture: true,
    label: 'pilot-shadow secret inventory',
  });
  const names = new Set(JSON.parse(secretOutput).map((entry) => entry.name));
  const missing = REQUIRED_SECRETS.filter((name) => !names.has(name));
  if (missing.length) fail(`required secret bindings missing: ${missing.join(',')}`);

  const builtAt = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const deployOutput = run(process.execPath, [
    wrangler,
    'deploy',
    '--config', CONFIG,
    '--var', `BUILD_SHA:${head}`,
    '--var', `BUILD_TIME:${builtAt}`,
    '--var', `XLOOOP_SCHEMA_HEAD:${candidate.schema_head}`,
  ], { capture: true, label: 'pilot-shadow deploy' });
  process.stdout.write(deployOutput);
  const versionId = deployOutput.match(/Current Version ID:\s*([0-9a-f-]+)/i)?.[1] || null;

  const expected = {
    build: head,
    builtAt,
    schemaHead: candidate.schema_head,
    contractHash: contract.contract_hash,
  };
  const health = await readHealth(expected);
  const receiptDir = path.resolve(process.env.XLOOOP_PILOT_SHADOW_RECEIPT_DIR || '/private/tmp');
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(receiptDir, `xlooop-pilot-shadow-deploy-${head.slice(0, 12)}.json`);
  const receipt = {
    schema_id: 'xlooop.pilot_shadow_deploy_receipt.v1',
    status: 'ratified',
    approval_reference: approvalRef,
    worker: WORKER,
    worker_version_id: versionId,
    api_base: API_BASE,
    backend_sha: head,
    built_at: builtAt,
    schema_head: candidate.schema_head,
    contract_hash: contract.contract_hash,
    environment: 'pilot-shadow',
    authority: 'shadow',
    health_readback: health,
    ratified_at: new Date().toISOString(),
    production_touched: false,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`deploy-pilot-shadow · RATIFIED · ${receiptPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
