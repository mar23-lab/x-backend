#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessFrontendReleaseArtifact,
  parseFrontendRuntimeManifest,
  parseFrontendReleaseHtml,
  posturesEqual,
} from './lib/app-pages-release-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.resolve(process.env.XLOOOP_APP_PAGES_RELEASE_DIR || path.join(root, 'dist-app-pages-release'));
const appUrl = String(process.env.XLOOOP_APP_URL || 'https://app.xlooop.com').replace(/\/+$/, '');
const requireSentry = process.env.XLOOOP_REQUIRE_SENTRY === '1';
const liveWaitSeconds = Number(process.env.XLOOOP_APP_LIVE_WAIT_SECONDS || '600');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizeAuthorizedHtml(html) {
  return String(html)
    .replace(
      /<script\s+data-xlooop-sentry-bootstrap\s+defer\s+src="\/sentry-bootstrap\.js\?release=[0-9a-f]{40}"><\/script>/i,
      '',
    )
    // Cloudflare consumes these exact control comments after applying Email
    // Address Obfuscation opt-out. Their absence is authorized transport
    // normalization; the protected mailto content remains hash-covered.
    .replaceAll('<!--email_off-->', '')
    .replaceAll('<!--/email_off-->', '');
}

export function authorizedHtmlMatchesArtifact(actual, artifact) {
  return sha256(Buffer.from(normalizeAuthorizedHtml(actual)))
    === sha256(Buffer.from(normalizeAuthorizedHtml(artifact)));
}

export function matchesDeploymentIdentity(actual, expected) {
  return actual?.frontend_sha === expected?.frontend_sha
    && actual?.backend_sha === expected?.backend_sha
    && actual?.artifact_digest === expected?.artifact_digest;
}

export function usesRuntimeManifest(artifactContract) {
  return artifactContract === 'react_vite_v2' || artifactContract === 'rich_ui_v3';
}

if (process.argv.includes('--self-test')) {
  const sha = 'a'.repeat(40);
  const artifact = '<html><head>\n<meta charset="utf-8"></head><body></body></html>';
  const authorized = artifact.replace(
    '<head>',
    `<head><script data-xlooop-sentry-bootstrap defer src="/sentry-bootstrap.js?release=${sha}"></script>`,
  );
  const stale = artifact.replace(
    '<head>',
    '<head><script data-xlooop-sentry-bootstrap defer src="/sentry-bootstrap.js?release=stale"></script>',
  );
  const emailProtected = artifact.replace(
    '<body>',
    '<body><!--email_off-->',
  ).replace('</body>', '<!--/email_off--></body>');
  const emailContentDrift = emailProtected.replace('<body>', '<body>changed');
  const checks = [
    ['authorized bootstrap normalizes to artifact bytes', normalizeAuthorizedHtml(authorized) === artifact],
    ['authorized email opt-out markers normalize to artifact bytes', normalizeAuthorizedHtml(emailProtected) === artifact],
    ['content inside email opt-out markers remains hash-covered', normalizeAuthorizedHtml(emailContentDrift) !== artifact],
    ['authorized transport transforms match the source artifact', authorizedHtmlMatchesArtifact(authorized, artifact)],
    ['stripped email markers match their protected source artifact', authorizedHtmlMatchesArtifact(artifact, emailProtected)],
    ['email content drift does not match its source artifact', !authorizedHtmlMatchesArtifact(emailContentDrift, emailProtected)],
    ['plain artifact remains unchanged', normalizeAuthorizedHtml(artifact) === artifact],
    ['malformed or stale bootstrap is not hidden', normalizeAuthorizedHtml(stale) !== artifact],
    ['exact deployment identity matches', matchesDeploymentIdentity({
      frontend_sha: sha,
      backend_sha: 'b'.repeat(40),
      artifact_digest: 'c'.repeat(64),
    }, {
      frontend_sha: sha,
      backend_sha: 'b'.repeat(40),
      artifact_digest: 'c'.repeat(64),
    })],
    ['stale frontend deployment does not match', !matchesDeploymentIdentity({
      frontend_sha: 'd'.repeat(40),
      backend_sha: 'b'.repeat(40),
      artifact_digest: 'c'.repeat(64),
    }, {
      frontend_sha: sha,
      backend_sha: 'b'.repeat(40),
      artifact_digest: 'c'.repeat(64),
    })],
    ['React release uses its runtime manifest', usesRuntimeManifest('react_vite_v2')],
    ['rich commercial release uses its runtime manifest', usesRuntimeManifest('rich_ui_v3')],
    ['legacy wired release keeps inline marker parsing', !usesRuntimeManifest('legacy_wired_v1')],
    ['600-second custom-domain convergence bound is accepted', (() => {
      try { validateLiveWaitSeconds(600); return true; } catch { return false; }
    })()],
    ['an unbounded custom-domain wait is refused', (() => {
      try { validateLiveWaitSeconds(601); return false; } catch { return true; }
    })()],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
  const passed = checks.filter(([, ok]) => ok).length;
  if (passed !== checks.length) process.exit(1);
  console.log(`verify-app-pages-live self-test PASS · ${passed}/${checks.length}`);
  process.exit(0);
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

export function validateLiveWaitSeconds(value) {
  if (!Number.isFinite(value) || value < 0 || value > 600) {
    throw new Error('XLOOOP_APP_LIVE_WAIT_SECONDS must be between 0 and 600');
  }
}

async function assessLiveRelease(manifest) {
  const failures = [];
  const nonce = `xlooop-release-${Date.now()}`;
  const runtimeManifestArtifact = usesRuntimeManifest(manifest.artifact_contract);
  const [indexResponse, manifestResponse, runtimeIdentityResponse, healthResponse] = await Promise.all([
    fetchRequired(`${appUrl}/?release_probe=${nonce}`),
    fetchRequired(`${appUrl}/release-manifest.json?release_probe=${nonce}`),
    fetchRequired(`${appUrl}/${runtimeManifestArtifact ? 'runtime-manifest.json' : 'contract-meta.js'}?release_probe=${nonce}`),
    fetchRequired(`${manifest.api_base}/api/v1/health?release_probe=${nonce}`),
  ]);
  const [indexBytes, liveManifest, runtimeIdentity, health] = await Promise.all([
    indexResponse.arrayBuffer().then((value) => Buffer.from(value)),
    parseJsonResponse(manifestResponse, 'live release manifest'),
    runtimeManifestArtifact
      ? parseJsonResponse(runtimeIdentityResponse, 'live runtime manifest')
      : runtimeIdentityResponse.text(),
    parseJsonResponse(healthResponse, 'backend health response'),
  ]);
  const html = indexBytes.toString('utf8');
  const config = runtimeManifestArtifact
    ? parseFrontendRuntimeManifest(runtimeIdentity)
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
  if (runtimeManifestArtifact) {
    const localRuntime = JSON.parse(readFileSync(path.join(releaseDir, 'runtime-manifest.json'), 'utf8'));
    if (JSON.stringify(runtimeIdentity) !== JSON.stringify(localRuntime)) failures.push('live_runtime_manifest');
  } else if (!runtimeIdentity.includes(manifest.contract_hash)) failures.push('live_contract_meta');
  if (html.includes('data-xlooop-sentry-bootstrap')) {
    if (!html.includes(`/sentry-bootstrap.js?release=${manifest.frontend_sha}`)) {
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

  const releaseHtml = readFileSync(path.join(releaseDir, 'index.html'), 'utf8');
  if (!authorizedHtmlMatchesArtifact(html, releaseHtml)) {
    failures.push('live_asset_hash:index.html');
  }

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
  return failures;
}

validateLiveWaitSeconds(liveWaitSeconds);
const manifest = JSON.parse(readFileSync(path.join(releaseDir, 'release-manifest.json'), 'utf8'));
const deadline = Date.now() + liveWaitSeconds * 1000;
let failures = ['release_not_yet_checked'];
do {
  try {
    failures = await assessLiveRelease(manifest);
  } catch (error) {
    failures = [error instanceof Error ? error.message : String(error)];
  }
  if (!failures.length) break;
  if (Date.now() >= deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
} while (true);

if (failures.length) {
  console.error(
    `verify-app-pages-live · FAIL-CLOSED · full release did not converge within ${liveWaitSeconds}s · `
      + `${[...new Set(failures)].join(',')}`,
  );
  process.exit(1);
}
console.log(`verify-app-pages-live · PASS · ${appUrl} exactly matches the assembled frontend/backend release`);
