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
  "last_reviewed: '2026-07-26'",
  'id: app',
  'url: https://app.xlooop.com',
  'source_repo: x-ai-front',
  'serving_source: wired',
  'serving_artifact: wired/dist-production',
  'pages_functions_repo: x-backend',
  'pages_functions_source: functions',
  'release_manifest: dist-app-pages-release/release-manifest.json',
  'deploy_script: deploy:app:prod',
  'id: api',
  'url: https://api.xlooop.com',
]) {
  if (!registry.includes(marker)) problems.push(`registry:${marker}`);
}

if (registry.includes('src/widgets/XcpScreenRouter/XcpScreenRouter.jsx')) {
  problems.push('stale_app_router');
}
if (pkg.scripts?.['deploy:app:prod'] !== 'node scripts/deploy-app-prod.mjs') {
  problems.push('package:deploy:app:prod');
}
const appDeploy = readFileSync(path.join(root, 'scripts/deploy-app-prod.mjs'), 'utf8');
const appPrepare = readFileSync(path.join(root, 'scripts/prepare-app-pages-release.mjs'), 'utf8');
for (const marker of [
  'XLOOOP_APP_PAGES_DECISION_PACKET',
  'authorization_expired',
  'deployment authorization has already been consumed',
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
  'normalizePagesFunctionsBundle',
  'Pages Functions bundle normalization failed',
]) {
  if (!appPrepare.includes(marker)) problems.push(`prepare_contract:${marker}`);
}
for (const file of [
  'functions/_middleware.js',
  'scripts/deploy-app-prod.mjs',
  'scripts/prepare-app-pages-release.mjs',
  'scripts/verify-app-pages-release.mjs',
  'scripts/verify-app-pages-live.mjs',
  'scripts/verify-app-pages-decision-packet.mjs',
]) {
  if (!existsSync(path.join(root, file))) problems.push(`missing:${file}`);
}

if (problems.length) {
  console.error(`verify-deployed-surfaces · FAIL-CLOSED · ${problems.join(',')}`);
  process.exit(1);
}
console.log('verify-deployed-surfaces · PASS · app and API ownership/deploy paths are source-backed');
