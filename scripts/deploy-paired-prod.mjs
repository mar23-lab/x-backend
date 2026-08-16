#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessPagesDecisionPacket,
  assessReleaseManifest,
  hashReleaseFiles,
  posturesEqual,
  releaseManifestDigest,
} from './lib/app-pages-release-contract.mjs';
import {
  assessPairedCutoverContract,
  executeCompensatingCutover,
  executePagesOnlyCutover,
} from './lib/paired-cutover-contract.mjs';
import { assessAuthorityPacket } from './verify-authority-decision-packet.mjs';
import {
  consumeDeploymentAuthorization,
  isDeploymentAuthorizationConsumed,
} from './lib/deployment-authorization-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const PAGES_ONLY = process.argv.includes('--pages-only');

function fail(message) {
  throw new Error(message);
}

function readJson(file, label) {
  if (!file || !existsSync(file)) fail(`${label} is required and must exist`);
  try { return JSON.parse(readFileSync(path.resolve(file), 'utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH',
  ]) delete env[key];
  return env;
}

function runNode(script, args = [], extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    env: { ...cleanGitEnv(), ...extraEnv },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`${script} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  if (result.stdout.trim()) console.log(result.stdout.trim());
}

function runWrangler(args, extraEnv = {}) {
  const cli = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT,
    env: { ...cleanGitEnv(), ...extraEnv, WRANGLER_LOG: 'none' },
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`wrangler ${args.slice(0, 2).join(' ')} exited ${String(result.status)}`);
}

async function verifyExistingApi(manifest) {
  const url = `${manifest.api_base.replace(/\/$/, '')}/api/v1/health?pages_only_cutover=${Date.now()}`;
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) fail(`existing API health returned HTTP ${response.status}`);
  const health = await response.json();
  const problems = [];
  if (health.status !== 'ok') problems.push('status');
  if (health.build !== manifest.backend_sha) problems.push('backend_sha');
  if (health.contract_hash !== manifest.contract_hash) problems.push('contract_hash');
  if (health.schema_head !== manifest.schema_head) problems.push('schema_head');
  if (health.environment !== manifest.environment) problems.push('environment');
  if (health.authority !== manifest.authority) problems.push('authority');
  if (!posturesEqual(health.feature_posture, manifest.feature_posture)) problems.push('feature_posture');
  if (problems.length) fail(`existing API does not satisfy Pages-only release: ${problems.join(',')}`);
  console.log(`pages-only API precondition PASS · backend=${health.build}`);
}

function pairedFixture() {
  const posture = {
    single_intake: true,
    role_skill_catalog: true,
    context_packet_persistence: true,
    chat_history_persistence_required: true,
    tenant_projection_queue: false,
    current_work_projection: true,
  };
  const backend = 'a'.repeat(40);
  const frontend = 'b'.repeat(40);
  const contract = 'c'.repeat(64);
  const cutover = '11111111-2222-4333-8444-555555555555';
  const manifest = {
    schema_id: 'xlooop.app_pages_release_manifest.v1',
    artifact_contract: 'react_vite_v2',
    frontend_sha: frontend,
    backend_sha: backend,
    contract_hash: contract,
    schema_head: 100,
    environment: 'production',
    authority: 'production',
    api_base: 'https://api.xlooop.com',
    feature_posture: posture,
    files: { 'index.html': 'd'.repeat(64) },
  };
  manifest.artifact_digest = releaseManifestDigest(manifest);
  const api = {
    cutover_id: cutover,
    candidate_commit_sha: backend,
    decision: { approver: 'operator', approval_reference: 'conversation:test' },
    rollback: { target_sha: 'e'.repeat(40) },
    expected_deployment: {
      worker_name: 'xlooop-api', build_sha: backend, contract_hash: contract, schema_head: 100,
      environment: 'production', authority: 'production', feature_posture: posture,
    },
    paired_frontend_release: {
      artifact_dir: '/tmp/release', artifact_digest: manifest.artifact_digest,
      artifact_contract: manifest.artifact_contract, frontend_sha: frontend, backend_sha: backend,
      contract_hash: contract, schema_head: 100, feature_posture: posture,
    },
  };
  const pages = {
    cutover_id: cutover,
    decision: { approver: 'operator', approval_reference: 'conversation:test' },
    candidate: { frontend_sha: frontend, backend_sha: backend },
    rollback: { frontend_sha: 'f'.repeat(40), backend_sha: api.rollback.target_sha },
    expected_deployment: {
      api_base: 'https://api.xlooop.com', artifact_digest: manifest.artifact_digest,
      artifact_contract: manifest.artifact_contract, contract_hash: contract, schema_head: 100,
      environment: 'production', authority: 'production', feature_posture: posture,
    },
  };
  return { api, pages, manifest, backend };
}

async function selfTest() {
  const fixture = pairedFixture();
  const valid = assessPairedCutoverContract(fixture.api, fixture.pages, fixture.manifest, fixture.backend);
  const schemaDrift = structuredClone(fixture);
  schemaDrift.pages.expected_deployment.schema_head = 99;
  const artifactDrift = structuredClone(fixture);
  artifactDrift.pages.expected_deployment.artifact_digest = '0'.repeat(64);
  const events = [];
  await executeCompensatingCutover({
    preflight: async () => events.push('preflight'),
    reserveAuthorizations: async () => events.push('reserve'),
    deployApi: async () => events.push('deploy-api'),
    ratifyApi: async () => events.push('ratify-api'),
    deployPages: async () => { events.push('deploy-pages'); throw new Error('injected Pages failure'); },
    ratifyPair: async () => events.push('ratify-pair'),
    rollbackPages: async () => events.push('rollback-pages'),
    rollbackApi: async () => events.push('rollback-api'),
  }).then(() => fail('injected failure unexpectedly passed')).catch((error) => {
    if (!String(error.message).includes('prior pair was restored')) throw error;
  });
  const apiRatifyEvents = [];
  const pagesOnlyEvents = [];
  await executeCompensatingCutover({
    preflight: async () => apiRatifyEvents.push('preflight'),
    reserveAuthorizations: async () => apiRatifyEvents.push('reserve'),
    deployApi: async () => apiRatifyEvents.push('deploy-api'),
    ratifyApi: async () => { apiRatifyEvents.push('ratify-api'); throw new Error('injected API ratification failure'); },
    deployPages: async () => apiRatifyEvents.push('deploy-pages'),
    ratifyPair: async () => apiRatifyEvents.push('ratify-pair'),
    rollbackPages: async () => apiRatifyEvents.push('rollback-pages'),
    rollbackApi: async () => apiRatifyEvents.push('rollback-api'),
  }).then(() => fail('injected API ratification failure unexpectedly passed')).catch((error) => {
    if (!String(error.message).includes('prior pair was restored')) throw error;
  });
  await executePagesOnlyCutover({
    preflight: async () => pagesOnlyEvents.push('preflight'),
    verifyExistingApi: async () => pagesOnlyEvents.push('verify-api'),
    reserveAuthorization: async () => pagesOnlyEvents.push('reserve-pages'),
    deployPages: async () => { pagesOnlyEvents.push('deploy-pages'); throw new Error('injected Pages failure'); },
    ratifyPair: async () => pagesOnlyEvents.push('ratify-pair'),
    rollbackPages: async () => pagesOnlyEvents.push('rollback-pages'),
  }).then(() => fail('injected Pages-only failure unexpectedly passed')).catch((error) => {
    if (!String(error.message).includes('prior Pages deployment was restored')) throw error;
  });
  const checks = [
    ['exact paired contract passes', valid.ok],
    ['schema drift is refused', assessPairedCutoverContract(
      schemaDrift.api, schemaDrift.pages, schemaDrift.manifest, schemaDrift.backend,
    ).problems.includes('expected_deployment_mismatch')],
    ['artifact drift is refused', assessPairedCutoverContract(
      artifactDrift.api, artifactDrift.pages, artifactDrift.manifest, artifactDrift.backend,
    ).problems.includes('pages_artifact_digest')],
    ['Pages failure restores Pages then API', events.slice(-2).join(',') === 'rollback-pages,rollback-api'],
    ['final pair ratification never ran after Pages failure', !events.includes('ratify-pair')],
    ['API ratification failure restores only the API surface',
      apiRatifyEvents.slice(-1)[0] === 'rollback-api' && !apiRatifyEvents.includes('rollback-pages')
      && !apiRatifyEvents.includes('deploy-pages')],
    ['Pages-only failure restores Pages without any API mutation',
      pagesOnlyEvents.join(',') === 'preflight,verify-api,reserve-pages,deploy-pages,rollback-pages'],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (failed.length) fail(`${failed.length}/${checks.length} paired cutover self-tests failed`);
  console.log(`deploy-paired-prod self-test PASS · ${checks.length - failed.length}/${checks.length}`);
}

async function pagesOnlyMain() {
  const pagesPath = process.env.XLOOOP_APP_PAGES_DECISION_PACKET;
  const releaseDir = path.resolve(
    process.env.XLOOOP_APP_PAGES_RELEASE_DIR || path.join(ROOT, 'dist-app-pages-release'),
  );
  const manifest = readJson(path.join(releaseDir, 'release-manifest.json'), 'release manifest');
  const pages = readJson(pagesPath, 'XLOOOP_APP_PAGES_DECISION_PACKET');
  const dirty = execFileSync('git', ['status', '--porcelain=v1'], {
    cwd: ROOT, env: cleanGitEnv(), encoding: 'utf8',
  }).trim();
  if (dirty) fail('Pages-only production cutover requires a clean orchestrator worktree');
  if (!manifest.backend_sha || pages?.candidate?.backend_sha !== manifest.backend_sha) {
    fail('Pages-only candidate backend does not match the assembled release');
  }
  const manifestAssessment = assessReleaseManifest(manifest, hashReleaseFiles(releaseDir));
  if (!manifestAssessment.ok) fail(`release manifest failed: ${manifestAssessment.problems.join(',')}`);
  const pagesAssessment = assessPagesDecisionPacket(pages, {
    cutover_id: pages.cutover_id,
    frontend_sha: manifest.frontend_sha,
    backend_sha: manifest.backend_sha,
    contract_hash: manifest.contract_hash,
    artifact_digest: manifest.artifact_digest,
    schema_head: manifest.schema_head,
    feature_posture: manifest.feature_posture,
    now: new Date().toISOString(),
  });
  if (!pagesAssessment.ok) fail(`Pages authority failed: ${pagesAssessment.problems.join(',')}`);
  if (isDeploymentAuthorizationConsumed(ROOT, 'pages', pages.decision.authorization_id)) {
    fail('Pages deployment authorization has already been consumed');
  }

  const receiptDir = path.resolve(process.env.XLOOOP_PAIRED_CUTOVER_RECEIPT_DIR
    || path.join('/private/tmp', `xlooop-cutover-${pages.cutover_id}`));
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const finalReceiptPath = path.join(receiptDir, 'paired-cutover-receipt.json');
  const sharedEnv = {
    XLOOOP_APP_PAGES_DECISION_PACKET: path.resolve(pagesPath),
    XLOOOP_APP_PAGES_RELEASE_DIR: releaseDir,
    XLOOOP_PAIRED_CUTOVER_INTERNAL: pages.cutover_id,
    XLOOOP_CUTOVER_MODE: 'pages_only',
    XLOOOP_PAGES_ONLY_BACKEND_SHA: manifest.backend_sha,
  };

  const result = await executePagesOnlyCutover({
    preflight: async () => {
      runNode('verify-app-pages-release.mjs', [], sharedEnv);
      runNode('verify-app-security-header-parity.mjs', ['--require-artifact'], sharedEnv);
    },
    verifyExistingApi: async () => verifyExistingApi(manifest),
    reserveAuthorization: async () => consumeDeploymentAuthorization(ROOT, 'pages', pages.decision.authorization_id, {
      schema_id: 'xlooop.paired_deployment_authorization_receipt.v1',
      cutover_id: pages.cutover_id,
      surface: 'pages', authorization_id: pages.decision.authorization_id,
      approval_reference: pages.decision.approval_reference, state: 'reserved_before_pages_only',
      candidate_sha: manifest.frontend_sha, artifact_digest: manifest.artifact_digest,
      reserved_at: new Date().toISOString(),
    }),
    deployPages: async () => runNode('deploy-app-prod.mjs', [], sharedEnv),
    ratifyPair: async () => {
      runNode('verify-app-pages-live.mjs', [], sharedEnv);
      runNode('verify-app-security-header-parity.mjs', ['--live', 'https://app.xlooop.com'], sharedEnv);
    },
    rollbackPages: async () => runNode('execute-declared-rollback.mjs', [
      '--packet', path.resolve(pagesPath), '--timeout-seconds', '180',
    ], sharedEnv),
  });

  const receipt = {
    schema_id: 'xlooop.paired_production_cutover_receipt.v1',
    cutover_id: pages.cutover_id,
    cutover_mode: 'pages_only',
    status: result.status,
    ratified_at: new Date().toISOString(),
    backend_sha: manifest.backend_sha,
    backend_mutated: false,
    frontend_sha: manifest.frontend_sha,
    artifact_digest: manifest.artifact_digest,
    contract_hash: manifest.contract_hash,
    schema_head: manifest.schema_head,
    feature_posture: manifest.feature_posture,
  };
  writeFileSync(finalReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`deploy-paired-prod · PAGES-ONLY RATIFIED · ${finalReceiptPath}`);
}

async function main() {
  if (SELF_TEST) return selfTest();
  if (PAGES_ONLY) return pagesOnlyMain();
  const apiPath = process.env.XLOOOP_AUTHORITY_DECISION_PACKET;
  const pagesPath = process.env.XLOOOP_APP_PAGES_DECISION_PACKET;
  const releaseDir = path.resolve(
    process.env.XLOOOP_APP_PAGES_RELEASE_DIR || path.join(ROOT, 'dist-app-pages-release'),
  );
  const manifestPath = path.join(releaseDir, 'release-manifest.json');
  const api = readJson(apiPath, 'XLOOOP_AUTHORITY_DECISION_PACKET');
  const pages = readJson(pagesPath, 'XLOOOP_APP_PAGES_DECISION_PACKET');
  const manifest = readJson(manifestPath, 'release manifest');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT, env: cleanGitEnv(), encoding: 'utf8',
  }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain=v1'], {
    cwd: ROOT, env: cleanGitEnv(), encoding: 'utf8',
  }).trim();
  if (dirty) fail('paired production cutover requires a clean backend worktree');

  const paired = assessPairedCutoverContract(api, pages, manifest, head);
  if (!paired.ok) fail(`paired cutover contract failed: ${paired.problems.join(',')}`);
  const manifestAssessment = assessReleaseManifest(manifest, hashReleaseFiles(releaseDir));
  if (!manifestAssessment.ok) fail(`release manifest failed: ${manifestAssessment.problems.join(',')}`);
  const apiAssessment = assessAuthorityPacket(api, 'deploy', head, {
    now: new Date().toISOString(),
    authorizationConsumed: isDeploymentAuthorizationConsumed(ROOT, 'api', api.decision.authorization_id),
  });
  if (!apiAssessment.ok) fail(`API authority failed: ${apiAssessment.problems.join(',')}`);
  const pagesAssessment = assessPagesDecisionPacket(pages, {
    cutover_id: paired.cutover_id,
    frontend_sha: manifest.frontend_sha,
    backend_sha: head,
    contract_hash: manifest.contract_hash,
    artifact_digest: manifest.artifact_digest,
    artifact_contract: manifest.artifact_contract,
    schema_head: manifest.schema_head,
    feature_posture: manifest.feature_posture,
    now: new Date().toISOString(),
  });
  if (!pagesAssessment.ok) fail(`Pages authority failed: ${pagesAssessment.problems.join(',')}`);
  if (isDeploymentAuthorizationConsumed(ROOT, 'pages', pages.decision.authorization_id)) {
    fail('Pages deployment authorization has already been consumed');
  }

  const receiptDir = path.resolve(process.env.XLOOOP_PAIRED_CUTOVER_RECEIPT_DIR
    || path.join('/private/tmp', `xlooop-cutover-${paired.cutover_id}`));
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const ratifiedApiPath = path.join(receiptDir, 'api-authority.ratified.json');
  const apiDeployReceiptPath = path.join(receiptDir, 'api-deploy-receipt.json');
  const finalReceiptPath = path.join(receiptDir, 'paired-cutover-receipt.json');
  const sharedEnv = {
    XLOOOP_AUTHORITY_DECISION_PACKET: path.resolve(apiPath),
    XLOOOP_APP_PAGES_DECISION_PACKET: path.resolve(pagesPath),
    XLOOOP_APP_PAGES_RELEASE_DIR: releaseDir,
    XLOOOP_PAIRED_CUTOVER_INTERNAL: paired.cutover_id,
  };

  const result = await executeCompensatingCutover({
    preflight: async () => {
      const nodeChecks = [
        ['verify-schema91-postgres.mjs'],
        ['preflight-rls-dsn.mjs'],
        ['preflight-model-runtime-keyring.mjs'],
        ['verify-rls-grant-parity.mjs'],
        ['verify-prod-migrations.mjs'],
        ['verify-projection-outbox-drain.mjs'],
        ['verify-operation-event-source-tool-constraint.mjs', ['--live']],
        ['verify-deploy-schema-head.mjs'],
        ['verify-deploy-sha-current.mjs'],
        ['verify-app-pages-release.mjs'],
        ['verify-app-security-header-parity.mjs', ['--require-artifact']],
        ['verify-frontend-pair-before-api-deploy.mjs'],
        ['verify-rollback-target-authority.mjs'],
      ];
      for (const [script, args = []] of nodeChecks) runNode(script, args, sharedEnv);
    },
    reserveAuthorizations: async () => {
      const reservedAt = new Date().toISOString();
      consumeDeploymentAuthorization(ROOT, 'api', api.decision.authorization_id, {
        schema_id: 'xlooop.paired_deployment_authorization_receipt.v1',
        cutover_id: paired.cutover_id,
        surface: 'api', authorization_id: api.decision.authorization_id,
        approval_reference: api.decision.approval_reference, state: 'reserved_before_pair',
        candidate_sha: head, artifact_digest: manifest.artifact_digest, reserved_at: reservedAt,
      });
      consumeDeploymentAuthorization(ROOT, 'pages', pages.decision.authorization_id, {
        schema_id: 'xlooop.paired_deployment_authorization_receipt.v1',
        cutover_id: paired.cutover_id,
        surface: 'pages', authorization_id: pages.decision.authorization_id,
        approval_reference: pages.decision.approval_reference, state: 'reserved_before_pair',
        candidate_sha: manifest.frontend_sha, artifact_digest: manifest.artifact_digest,
        reserved_at: reservedAt,
      });
    },
    deployApi: async () => runWrangler([
      'deploy', '--config', 'wrangler.toml',
      '--var', `BUILD_SHA:${head}`,
      '--var', `BUILD_TIME:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`,
      '--var', `XLOOOP_SCHEMA_HEAD:${process.env.XLOOOP_SCHEMA_HEAD}`,
    ]),
    ratifyApi: async () => {
      runNode('emit-deploy-receipt.mjs', [
        '--wait', '120', '--receipt', apiDeployReceiptPath,
      ], sharedEnv);
      runNode('ratify-authority-decision-packet.mjs', [
        '--wait', '120', '--out', ratifiedApiPath,
      ], sharedEnv);
    },
    deployPages: async () => runNode('deploy-app-prod.mjs', [], {
      ...sharedEnv,
      XLOOOP_PAIRED_CUTOVER_INTERNAL: paired.cutover_id,
    }),
    ratifyPair: async () => {
      runNode('verify-app-pages-live.mjs', [], sharedEnv);
      runNode('verify-app-security-header-parity.mjs', ['--live', 'https://app.xlooop.com'], sharedEnv);
    },
    rollbackPages: async () => runNode('execute-declared-rollback.mjs', [
      '--packet', path.resolve(pagesPath), '--timeout-seconds', '180',
    ], sharedEnv),
    rollbackApi: async () => runNode('execute-declared-rollback.mjs', [
      '--packet', path.resolve(apiPath), '--timeout-seconds', '180',
    ], sharedEnv),
  });

  const receipt = {
    schema_id: 'xlooop.paired_production_cutover_receipt.v1',
    cutover_id: paired.cutover_id,
    status: result.status,
    ratified_at: new Date().toISOString(),
    backend_sha: head,
    frontend_sha: manifest.frontend_sha,
    artifact_digest: manifest.artifact_digest,
    contract_hash: manifest.contract_hash,
    schema_head: manifest.schema_head,
    feature_posture: manifest.feature_posture,
    api_ratification: ratifiedApiPath,
    api_deploy_receipt: apiDeployReceiptPath,
  };
  writeFileSync(finalReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`deploy-paired-prod · RATIFIED · ${finalReceiptPath}`);
}

try {
  await main();
} catch (error) {
  const rollback = error?.rollback ? ` rollback=${JSON.stringify(error.rollback)}` : '';
  console.error(`deploy-paired-prod · FAIL-CLOSED · ${error instanceof Error ? error.message : String(error)}${rollback}`);
  process.exit(1);
}
