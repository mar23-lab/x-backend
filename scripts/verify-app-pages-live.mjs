#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessFrontendReleaseArtifact,
  parseReactRuntimeManifest,
  parseFrontendReleaseHtml,
  posturesEqual,
} from './lib/app-pages-release-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.resolve(process.env.XLOOOP_APP_PAGES_RELEASE_DIR || path.join(root, 'dist-app-pages-release'));
const appUrl = String(process.env.XLOOOP_APP_URL || 'https://app.xlooop.com').replace(/\/+$/, '');
const requireSentry = process.env.XLOOOP_REQUIRE_SENTRY === '1';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchRequired(url) {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const contentType = response.headers.get('content-type') || 'unknown';
    throw new Error(`${label} is not valid JSON (content-type=${contentType})`);
  }
}

const failures = [];
try {
  const manifest = JSON.parse(readFileSync(path.join(releaseDir, 'release-manifest.json'), 'utf8'));
  const nonce = `xlooop-release-${Date.now()}`;
  const reactArtifact = manifest.artifact_contract === 'react_vite_v2';
  const [indexResponse, manifestResponse, runtimeIdentityResponse, healthResponse] = await Promise.all([
    fetchRequired(`${appUrl}/?release_probe=${nonce}`),
    fetchRequired(`${appUrl}/release-manifest.json?release_probe=${nonce}`),
    fetchRequired(`${appUrl}/${reactArtifact ? 'runtime-manifest.json' : 'contract-meta.js'}?release_probe=${nonce}`),
    fetchRequired(`${manifest.api_base}/api/v1/health?release_probe=${nonce}`),
  ]);
  const [indexBytes, liveManifest, runtimeIdentity, health] = await Promise.all([
    indexResponse.arrayBuffer().then((value) => Buffer.from(value)),
    parseJsonResponse(manifestResponse, 'live release manifest'),
    reactArtifact
      ? parseJsonResponse(runtimeIdentityResponse, 'live runtime manifest')
      : runtimeIdentityResponse.text(),
    parseJsonResponse(healthResponse, 'backend health response'),
  ]);
  const html = indexBytes.toString('utf8');
  const config = reactArtifact
    ? parseReactRuntimeManifest(runtimeIdentity)
    : parseFrontendReleaseHtml(html);
  const artifact = assessFrontendReleaseArtifact(config, {
    frontend_sha: manifest.frontend_sha,
    backend_sha: manifest.backend_sha,
    contract_hash: manifest.contract_hash,
    schema_head: manifest.schema_head,
    feature_posture: manifest.feature_posture,
  });
  failures.push(...artifact.problems);
  if (JSON.stringify(liveManifest) !== JSON.stringify(manifest)) failures.push('live_release_manifest');
  if (reactArtifact) {
    const localRuntime = JSON.parse(readFileSync(path.join(releaseDir, 'runtime-manifest.json'), 'utf8'));
    if (JSON.stringify(runtimeIdentity) !== JSON.stringify(localRuntime)) failures.push('live_runtime_manifest');
  } else if (!runtimeIdentity.includes(manifest.contract_hash)) failures.push('live_contract_meta');
  if (html.includes('data-xlooop-sentry-bootstrap')) {
    if (!html.includes(`window.SENTRY_RELEASE="${manifest.frontend_sha}"`)) {
      failures.push('live_sentry_release');
    }
  } else if (requireSentry) {
    failures.push('live_sentry_bootstrap');
  }

  const expectedHeaders = JSON.parse(
    readFileSync(path.join(root, 'data/security-headers.manifest.json'), 'utf8'),
  ).global_headers;
  for (const [name, value] of Object.entries(expectedHeaders)) {
    if (indexResponse.headers.get(name) !== value) failures.push(`live_header:${name}`);
  }

  if (health.status !== 'ok') failures.push('health_status');
  if (health.build !== manifest.backend_sha) failures.push('health_build');
  if (health.contract_hash !== manifest.contract_hash) failures.push('health_contract_hash');
  if (Number(health.schema_head) !== manifest.schema_head) failures.push('health_schema_head');
  if (health.environment !== manifest.environment) failures.push('health_environment');
  if (health.authority !== manifest.authority) failures.push('health_authority');
  if (!posturesEqual(health.feature_posture, manifest.feature_posture)) {
    failures.push('health_feature_posture');
  }
  if (health?.bindings?.model_runtime_keyring !== true) failures.push('health_model_runtime_keyring');

  if (sha256(indexBytes) !== manifest.files['index.html']) failures.push('live_asset_hash:index.html');

  const publicAssets = Object.entries(manifest.files).filter(([relative]) => ![
    '_headers',
    '_routes.json',
    'index.html',
  ].includes(relative) && !relative.startsWith('_worker.js/'));
  for (const [relative, expectedHash] of publicAssets) {
    const response = await fetchRequired(`${appUrl}/${relative}?release_probe=${nonce}`);
    const actualHash = sha256(Buffer.from(await response.arrayBuffer()));
    if (actualHash !== expectedHash) failures.push(`live_asset_hash:${relative}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

if (failures.length) {
  console.error(`verify-app-pages-live · FAIL-CLOSED · ${[...new Set(failures)].join(',')}`);
  process.exit(1);
}
console.log(`verify-app-pages-live · PASS · ${appUrl} exactly matches the assembled frontend/backend release`);
