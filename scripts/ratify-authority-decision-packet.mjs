#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessAuthorityPacket } from './verify-authority-decision-packet.mjs';
import { isDeploymentAuthorizationConsumed } from './lib/deployment-authorization-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const SELF_TEST = ARGV.includes('--self-test');
const EXPECTED_SELF_TEST_COUNT = 7;
const POSTURE_KEYS = [
  'single_intake',
  'role_skill_catalog',
  'context_packet_persistence',
  'chat_history_persistence_required',
  'tenant_projection_queue',
  'current_work_projection',
];

function arg(name, fallback = null) {
  const index = ARGV.indexOf(`--${name}`);
  return index >= 0 && ARGV[index + 1] && !ARGV[index + 1].startsWith('--')
    ? ARGV[index + 1]
    : fallback;
}

function fail(message) {
  console.error(`ratify-authority-decision-packet · FAIL-CLOSED · ${message}`);
  process.exit(1);
}

export function healthProblems(health, expected) {
  const problems = [];
  if (health?.status !== 'ok') problems.push('health_status');
  if (health?.build !== expected?.build_sha) problems.push('health_build');
  if (health?.contract_hash !== expected?.contract_hash) problems.push('health_contract_hash');
  if (health?.schema_head !== expected?.schema_head) problems.push('health_schema_head');
  if (health?.environment !== expected?.environment) problems.push('health_environment');
  if (health?.authority !== expected?.authority) problems.push('health_authority');
  const actualPosture = health?.feature_posture;
  const expectedPosture = expected?.feature_posture;
  const exactPosture = actualPosture && expectedPosture
    && Object.keys(actualPosture).length === POSTURE_KEYS.length
    && Object.keys(expectedPosture).length === POSTURE_KEYS.length
    && POSTURE_KEYS.every((key) => typeof actualPosture[key] === 'boolean'
      && actualPosture[key] === expectedPosture[key]);
  if (!exactPosture) {
    problems.push('health_feature_posture');
  }
  if (health?.bindings?.model_runtime_keyring !== true) {
    problems.push('health_model_runtime_keyring');
  }
  return problems;
}

export function buildRatifiedPacket(approved, health, observedAt) {
  const expected = approved.expected_deployment;
  return {
    ...approved,
    status: 'ratified',
    deployment_allowed: false,
    exact_deployed_sha_verified: true,
    deployment: {
      reported_build: health.build,
      contract_hash: health.contract_hash,
      schema_head: health.schema_head,
      environment: health.environment,
      authority: health.authority,
      feature_posture: health.feature_posture,
    },
    health_observation: {
      observed_at: observedAt,
      endpoint: 'https://api.xlooop.com/api/v1/health',
      response: health,
    },
    ratification: {
      ratified_at: observedAt,
      authorization_id: approved.decision.authorization_id,
      verifier: 'scripts/ratify-authority-decision-packet.mjs',
    },
  };
}

async function observeExpectedHealth(apiBase, expected, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastHealth = null;
  let lastProblems = ['health_not_observed'];
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/v1/health?ratify=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        lastHealth = await response.json();
        lastProblems = healthProblems(lastHealth, expected);
        if (lastProblems.length === 0) return lastHealth;
      } else {
        lastProblems = [`health_http_${response.status}`];
      }
    } catch (error) {
      lastProblems = [error instanceof Error ? error.message : String(error)];
    }
    if (Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
  }
  fail(`live health never matched the approved candidate: ${lastProblems.join(',')}`);
}

function selfTest() {
  const posture = {
    single_intake: true,
    role_skill_catalog: true,
    context_packet_persistence: true,
    chat_history_persistence_required: true,
    tenant_projection_queue: false,
    current_work_projection: true,
  };
  const approved = {
    schema_id: 'xlooop.authority_decision_packet.v2',
    status: 'approved_to_deploy',
    deployment_allowed: true,
    exact_deployed_sha_verified: false,
    decision: { authorization_id: '36eb5d20-49d9-4ed9-b623-0f7250797244' },
    expected_deployment: {
      build_sha: 'a'.repeat(40),
      contract_hash: 'b'.repeat(64),
      schema_head: 100,
      environment: 'production',
      authority: 'production',
      feature_posture: posture,
    },
  };
  const health = {
    status: 'ok',
    build: approved.expected_deployment.build_sha,
    contract_hash: approved.expected_deployment.contract_hash,
    schema_head: 100,
    environment: 'production',
    authority: 'production',
    feature_posture: posture,
    bindings: { model_runtime_keyring: true },
  };
  const ratified = buildRatifiedPacket(approved, health, '2026-08-10T00:00:00Z');
  const checks = [
    ['exact health passes', healthProblems(health, approved.expected_deployment).length === 0],
    ['schema drift fails', healthProblems({ ...health, schema_head: 99 }, approved.expected_deployment).includes('health_schema_head')],
    ['missing runtime keyring fails', healthProblems({ ...health, bindings: {} }, approved.expected_deployment).includes('health_model_runtime_keyring')],
    ['contract drift fails', healthProblems({ ...health, contract_hash: 'c'.repeat(64) }, approved.expected_deployment).includes('health_contract_hash')],
    ['posture key order does not create false drift', healthProblems({
      ...health,
      feature_posture: Object.fromEntries(Object.entries(posture).reverse()),
    }, approved.expected_deployment).length === 0],
    ['ratification consumes deployment authority', ratified.status === 'ratified' && ratified.deployment_allowed === false],
    ['ratification records exact build', ratified.deployment.reported_build === approved.expected_deployment.build_sha],
  ];
  const failures = checks.filter(([, ok]) => !ok);
  if (checks.length !== EXPECTED_SELF_TEST_COUNT) {
    fail(`self-test definition drift: expected ${EXPECTED_SELF_TEST_COUNT}, got ${checks.length}`);
  }
  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (failures.length) fail(`${failures.length}/${checks.length} self-test controls failed`);
  console.log(`ratify-authority-decision-packet self-test PASS · ${checks.length - failures.length}/${EXPECTED_SELF_TEST_COUNT}`);
}

async function main() {
  if (SELF_TEST) return selfTest();
  const approvedPath = process.env.XLOOOP_AUTHORITY_DECISION_PACKET;
  if (!approvedPath) fail('XLOOOP_AUTHORITY_DECISION_PACKET is required');
  const absoluteApproved = path.resolve(approvedPath);
  if (!existsSync(absoluteApproved)) fail(`approval packet does not exist: ${absoluteApproved}`);
  const approved = JSON.parse(readFileSync(absoluteApproved, 'utf8'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const approval = assessAuthorityPacket(approved, 'observe', head, { now: new Date().toISOString() });
  if (!approval.ok || approved.status !== 'approved_to_deploy') {
    fail(`approval packet is not eligible for ratification: ${approval.problems.join(',')}`);
  }
  if (!isDeploymentAuthorizationConsumed(ROOT, 'api', approved.decision.authorization_id)) {
    fail('deployment authorization was not reserved before ratification');
  }

  const waitSeconds = Number(arg('wait', '120'));
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) {
    fail('--wait must be an integer from 0 to 600 seconds');
  }
  const health = await observeExpectedHealth(
    arg('api-base', 'https://api.xlooop.com'),
    approved.expected_deployment,
    waitSeconds,
  );
  const observedAt = new Date().toISOString();
  const ratified = buildRatifiedPacket(approved, health, observedAt);
  const out = path.resolve(arg(
    'out',
    absoluteApproved.replace(/\.json$/i, '') + '.ratified.json',
  ));
  const repoPrefix = `${ROOT}${path.sep}`;
  if (out.startsWith(repoPrefix)) fail('ratification output must be outside the repository');
  writeFileSync(out, `${JSON.stringify(ratified, null, 2)}\n`);

  const verification = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'verify-authority-decision-packet.mjs'), '--require-ratified'],
    {
      cwd: ROOT,
      env: { ...process.env, XLOOOP_AUTHORITY_DECISION_PACKET: out },
      encoding: 'utf8',
    },
  );
  if (verification.status !== 0) {
    fail(`emitted ratification failed verification: ${verification.stderr || verification.stdout}`);
  }
  console.log(`ratify-authority-decision-packet · PASS · ${out}`);
}

await main();
