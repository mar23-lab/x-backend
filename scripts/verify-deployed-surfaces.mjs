#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.join(root, 'docs/deployment/DEPLOYED_SURFACES.yml');
const registry = readFileSync(registryPath, 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const problems = [];

for (const marker of [
  'schema_id: xlooop.deployed_surfaces.v1',
  "last_reviewed: '2026-08-10'",
  'id: app',
  'url: https://app.xlooop.com',
  'source_repo: x-ai-front',
  'serving_source: app',
  'serving_artifact: app/dist',
  'artifact_contract: react_vite_v2',
  'pages_functions_repo: x-backend',
  'pages_functions_source: functions',
  'release_manifest: dist-app-pages-release/release-manifest.json',
  'deploy_script: deploy:paired:prod',
  'id: api',
  'url: https://api.xlooop.com',
]) {
  if (!registry.includes(marker)) problems.push(`registry:${marker}`);
}

if (registry.includes('src/widgets/XcpScreenRouter/XcpScreenRouter.jsx')) {
  problems.push('stale_app_router');
}
const pairedCommand = 'node scripts/deploy-paired-prod.mjs';
for (const alias of ['deploy:api', 'deploy:app:prod', 'deploy:paired:prod']) {
  if (pkg.scripts?.[alias] !== pairedCommand) problems.push(`package:${alias}`);
}
const appDeploy = readFileSync(path.join(root, 'scripts/deploy-app-prod.mjs'), 'utf8');
const pairedDeploy = readFileSync(path.join(root, 'scripts/deploy-paired-prod.mjs'), 'utf8');
const appPrepare = readFileSync(path.join(root, 'scripts/prepare-app-pages-release.mjs'), 'utf8');
const rollbackExecutor = readFileSync(path.join(root, 'scripts/execute-declared-rollback.mjs'), 'utf8');
const liveVerifier = readFileSync(path.join(root, 'scripts/verify-app-pages-live.mjs'), 'utf8');
const apiAuthorization = readFileSync(
  path.join(root, 'scripts/consume-api-deployment-authorization.mjs'),
  'utf8',
);
const authorizationStore = readFileSync(
  path.join(root, 'scripts/lib/deployment-authorization-store.mjs'),
  'utf8',
);
for (const marker of [
  'XLOOOP_APP_PAGES_DECISION_PACKET',
  'authorization_expired',
  'deployment authorization has already been consumed',
  'reserved_before_pair',
  'verify-rollback-target-authority.mjs',
  'rollbackPages',
  'rollbackApi',
]) {
  if (!pairedDeploy.includes(marker) && !readFileSync(
    path.join(root, 'scripts/lib/app-pages-release-contract.mjs'),
    'utf8',
  ).includes(marker)) {
    problems.push(`paired_deploy_contract:${marker}`);
  }
}
for (const marker of [
  'standalone Pages production deploy is disabled',
  "'--commit-dirty=false'",
  "'--no-bundle'",
]) {
  if (!appDeploy.includes(marker) && !readFileSync(
    path.join(root, 'scripts/lib/app-pages-release-contract.mjs'),
    'utf8',
  ).includes(marker)) {
    problems.push(`deploy_contract:${marker}`);
  }
}
for (const marker of [
  'reserved_before_pair',
  'git-common-dir',
  'openSync(receiptPath, \'wx\'',
]) {
  if (!pairedDeploy.includes(marker)
      && !apiAuthorization.includes(marker)
      && !authorizationStore.includes(marker)) {
    problems.push(`authorization_contract:${marker}`);
  }
}
for (const marker of [
  'normalizePagesFunctionsBundle',
  'Pages Functions bundle normalization failed',
  "runtimeManifest.files['index.html'] = createHash('sha256').update(identifiedHtml).digest('hex')",
]) {
  if (!appPrepare.includes(marker)) problems.push(`prepare_contract:${marker}`);
}
for (const marker of [
  '/pages/projects/xlooop-app/deployments/${targetId}/rollback',
  "'auth', 'token', '--json'",
]) {
  if (!rollbackExecutor.includes(marker)) problems.push(`rollback_contract:${marker}`);
}
if (rollbackExecutor.includes("'pages', 'deployment', 'promote'")) {
  problems.push('rollback_contract:removed_wrangler_pages_promote_command');
}
for (const marker of ['normalizeAuthorizedHtml', '/sentry-bootstrap.js?release=${manifest.frontend_sha}']) {
  if (!liveVerifier.includes(marker)) problems.push(`live_verifier_contract:${marker}`);
}
for (const file of [
  'functions/_middleware.js',
  'scripts/deploy-paired-prod.mjs',
  'scripts/deploy-app-prod.mjs',
  'scripts/prepare-app-pages-release.mjs',
  'scripts/verify-app-pages-release.mjs',
  'scripts/verify-app-pages-live.mjs',
  'scripts/verify-app-pages-decision-packet.mjs',
  'scripts/consume-api-deployment-authorization.mjs',
  'scripts/lib/deployment-authorization-store.mjs',
  'scripts/verify-deployment-authorization-store.mjs',
  'scripts/verify-rollback-target-authority.mjs',
]) {
  if (!existsSync(path.join(root, file))) problems.push(`missing:${file}`);
}

if (problems.length) {
  console.error(`verify-deployed-surfaces · FAIL-CLOSED · ${problems.join(',')}`);
  process.exit(1);
}
console.log('verify-deployed-surfaces · PASS · React app and API converge on one paired, rollback-bound production path');
