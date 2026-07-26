#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessPagesDecisionPacket } from './lib/app-pages-release-contract.mjs';
import {
  consumeDeploymentAuthorization,
  isDeploymentAuthorizationConsumed,
} from './lib/deployment-authorization-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.resolve(process.env.XLOOOP_APP_PAGES_RELEASE_DIR || path.join(root, 'dist-app-pages-release'));
const packetPath = process.env.XLOOOP_APP_PAGES_DECISION_PACKET;

function fail(message) {
  console.error(`deploy-app-prod · FAIL-CLOSED · ${message}`);
  process.exit(1);
}

if (!packetPath) fail('XLOOOP_APP_PAGES_DECISION_PACKET is required');
const verifyRelease = spawnSync(process.execPath, [path.join(root, 'scripts/verify-app-pages-release.mjs')], {
  cwd: root,
  env: { ...process.env, XLOOOP_APP_PAGES_RELEASE_DIR: releaseDir },
  encoding: 'utf8',
});
if (verifyRelease.status !== 0) fail(verifyRelease.stderr || verifyRelease.stdout);

const manifest = JSON.parse(readFileSync(path.join(releaseDir, 'release-manifest.json'), 'utf8'));
const packet = JSON.parse(readFileSync(path.resolve(packetPath), 'utf8'));
const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const backendDirty = execFileSync('git', ['status', '--porcelain=v1'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
if (backendDirty) fail('production deploy requires a clean backend worktree');
const decision = assessPagesDecisionPacket(packet, {
  frontend_sha: manifest.frontend_sha,
  backend_sha: backendSha,
  contract_hash: manifest.contract_hash,
  schema_head: manifest.schema_head,
  feature_posture: manifest.feature_posture,
  now: new Date().toISOString(),
});
if (!decision.ok) fail(decision.problems.join(','));
if (isDeploymentAuthorizationConsumed(root, 'pages', packet.decision.authorization_id)) {
  fail('deployment authorization has already been consumed');
}

try {
  consumeDeploymentAuthorization(root, 'pages', packet.decision.authorization_id, {
    schema_id: 'xlooop.app_pages_deployment_authorization_receipt.v1',
    authorization_id: packet.decision.authorization_id,
    approval_reference: packet.decision.approval_reference,
    frontend_sha: manifest.frontend_sha,
    backend_sha: manifest.backend_sha,
    project_name: packet.target.project_name,
    state: 'reserved_before_deploy',
    reserved_at: new Date().toISOString(),
    consequence: 'a failed or interrupted deploy attempt requires a new operator authorization',
  });
} catch (error) {
  fail(
    error?.code === 'EEXIST'
      ? 'deployment authorization has already been consumed'
      : error instanceof Error ? error.message : String(error),
  );
}

const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler');
const deploy = spawnSync(
  wrangler,
  [
    'pages',
    'deploy',
    releaseDir,
    '--project-name',
    'xlooop-app',
    '--branch',
    'main',
    '--commit-hash',
    manifest.frontend_sha,
    '--commit-dirty=false',
    '--no-bundle',
    '--commit-message',
    `xlooop-app frontend ${manifest.frontend_sha} backend ${manifest.backend_sha}`,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (deploy.status !== 0) fail(`wrangler pages deploy exited ${String(deploy.status)}`);
console.log(
  `deploy-app-prod · DEPLOYED · frontend=${manifest.frontend_sha} backend=${manifest.backend_sha}`
  + ' · post-deploy ratification and live probes are still required',
);
