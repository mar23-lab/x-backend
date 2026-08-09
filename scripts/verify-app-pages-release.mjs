#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessFrontendReleaseArtifact,
  assessReleaseManifest,
  hashReleaseFiles,
  normalizePagesFunctionsBundle,
  PAGES_FUNCTIONS_ROUTE_SOURCE_MARKER,
  parseFrontendReleaseArtifact,
  verifyStaticArtifactFiles,
} from './lib/app-pages-release-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.resolve(process.env.XLOOOP_APP_PAGES_RELEASE_DIR || path.join(root, 'dist-app-pages-release'));
const manifestPath = path.join(releaseDir, 'release-manifest.json');
const problems = [];
const selfTest = process.argv.includes('--self-test');

function runSelfTest() {
  const testRoot = path.join(os.tmpdir(), `xlooop-app-pages-contract-${process.pid}`);
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(path.join(testRoot, 'vendor'), { recursive: true });
  const frontendSha = 'a'.repeat(40);
  const backendSha = 'b'.repeat(40);
  const contractHash = 'c'.repeat(64);
  const posture = {
    single_intake: true,
    role_skill_catalog: true,
    context_packet_persistence: true,
    chat_history_persistence_required: true,
    tenant_projection_queue: false,
    current_work_projection: false,
  };
  const config = `<script>window.__XLOOP_BUILD_MODE="production";`
    + 'window.__XLOOP_REQUIRE_CONTRACT_HANDSHAKE=true;'
    + 'window.__XLOOP_API_BASE="https://api.xlooop.com";'
    + `window.__XLOOP_FRONTEND_SHA="${frontendSha}";`
    + `window.__XLOOP_EXPECTED_BACKEND_SHA="${backendSha}";`
    + 'window.__XLOOP_EXPECTED_SCHEMA_HEAD=89;'
    + 'window.__XLOOP_EXPECTED_ENVIRONMENT="production";'
    + 'window.__XLOOP_EXPECTED_AUTHORITY="production";'
    + `window.__XLOOP_EXPECTED_FEATURE_POSTURE=${JSON.stringify(posture)};</script>`;
  writeFileSync(path.join(testRoot, 'index.html'), config);
  writeFileSync(path.join(testRoot, '_headers'), '/*\n  X-Robots-Tag: noindex\n');
  writeFileSync(path.join(testRoot, 'clerk-boot.js'), '');
  writeFileSync(path.join(testRoot, 'contract-meta.js'), contractHash);
  writeFileSync(path.join(testRoot, 'live-data.js'), '');
  writeFileSync(path.join(testRoot, 'support.js'), '');
  writeFileSync(path.join(testRoot, 'vendor/runtime.js'), '');

  const parsed = parseFrontendReleaseArtifact(testRoot);
  const valid = assessFrontendReleaseArtifact(parsed, { frontend_sha: frontendSha, backend_sha: backendSha });
  const wrongBackend = assessFrontendReleaseArtifact(parsed, {
    frontend_sha: frontendSha,
    backend_sha: 'd'.repeat(40),
  });
  const staticProblems = verifyStaticArtifactFiles(testRoot, contractHash);
  const hashes = hashReleaseFiles(testRoot);
  const manifest = {
    schema_id: 'xlooop.app_pages_release_manifest.v1',
    frontend_sha: frontendSha,
    backend_sha: backendSha,
    contract_hash: contractHash,
    schema_head: 89,
    environment: 'production',
    authority: 'production',
    feature_posture: posture,
    files: hashes,
  };
  const validManifest = assessReleaseManifest(manifest, hashes);
  const tamperedManifest = assessReleaseManifest(manifest, { ...hashes, 'index.html': 'd'.repeat(64) });
  const randomRouteCommentA =
    '// ../.wrangler/tmp/pages-4T2Zm4/functionsRoutes-0.44016116637048475.mjs';
  const randomRouteCommentB =
    '// ../../.wrangler/tmp/pages-BbcO6f/functionsRoutes-0.9163805584323002.mjs';
  const normalizedA = normalizePagesFunctionsBundle(`${randomRouteCommentA}\nexport default {};\n`);
  const normalizedB = normalizePagesFunctionsBundle(`${randomRouteCommentB}\nexport default {};\n`);
  const duplicateRouteCommentsRejected = (() => {
    try {
      normalizePagesFunctionsBundle(`${randomRouteCommentA}\n${randomRouteCommentB}\n`);
      return false;
    } catch {
      return true;
    }
  })();
  const unknownTmpCommentRejected = (() => {
    try {
      normalizePagesFunctionsBundle('// ../.wrangler/tmp/pages-random/unknown.mjs\n');
      return false;
    } catch {
      return true;
    }
  })();
  const checks = [
    ['valid artifact', valid.ok],
    ['wrong backend rejected', !wrongBackend.ok && wrongBackend.problems.includes('backend_sha_mismatch')],
    ['required files valid', staticProblems.length === 0],
    ['valid manifest', validManifest.ok],
    ['tampered file rejected', !tamperedManifest.ok && tamperedManifest.problems.includes('file_hashes')],
    ['randomized route comments normalize identically', normalizedA === normalizedB],
    ['normalized marker is stable', normalizePagesFunctionsBundle(normalizedA) === normalizedA],
    ['normalized marker is present once', normalizedA.split(PAGES_FUNCTIONS_ROUTE_SOURCE_MARKER).length === 2],
    ['duplicate route comments rejected', duplicateRouteCommentsRejected],
    ['unknown Wrangler tmp comment rejected', unknownTmpCommentRejected],
  ];
  rmSync(testRoot, { recursive: true, force: true });
  const failures = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failures.length) {
    console.error(`verify-app-pages-release self-test · FAIL · ${failures.join(',')}`);
    process.exit(1);
  }
  const passed = checks.length - failures.length;
  console.log(`verify-app-pages-release self-test · PASS ${passed}/${checks.length}`);
}

if (selfTest) {
  runSelfTest();
  process.exit(0);
}

try {
  if (!existsSync(manifestPath)) throw new Error(`missing ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const contract = JSON.parse(readFileSync(path.join(root, 'docs/contracts/api-contract.v1.json'), 'utf8'));
  const config = parseFrontendReleaseArtifact(releaseDir);
  const artifact = assessFrontendReleaseArtifact(config, {
    frontend_sha: manifest.frontend_sha,
    backend_sha: backendSha,
  });
  problems.push(...artifact.problems);
  problems.push(...verifyStaticArtifactFiles(releaseDir, contract.contract_hash));
  const workerBundlePath = path.join(releaseDir, '_worker.js', 'index.js');
  if (!existsSync(workerBundlePath)) {
    problems.push('missing:_worker.js/index.js');
  } else {
    try {
      const workerBundle = readFileSync(workerBundlePath, 'utf8');
      if (normalizePagesFunctionsBundle(workerBundle) !== workerBundle) {
        problems.push('unnormalized:_worker.js/index.js');
      }
    } catch (error) {
      problems.push(
        `invalid:_worker.js/index.js:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (!existsSync(path.join(releaseDir, '_routes.json'))) problems.push('missing:_routes.json');
  if (manifest.backend_sha !== backendSha) problems.push('manifest_backend_sha_mismatch');
  if (manifest.contract_hash !== contract.contract_hash) problems.push('manifest_contract_hash_mismatch');
  if (manifest.frontend_sha !== config.frontend_sha) problems.push('manifest_frontend_sha_mismatch');
  if (manifest.schema_head !== config.schema_head) problems.push('manifest_schema_head_mismatch');
  const manifestAssessment = assessReleaseManifest(manifest, hashReleaseFiles(releaseDir));
  problems.push(...manifestAssessment.problems);
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}

if (problems.length) {
  console.error(`verify-app-pages-release · FAIL-CLOSED · ${[...new Set(problems)].join(',')}`);
  process.exit(1);
}
console.log('verify-app-pages-release · PASS · exact frontend/backend artifact and Pages Functions bundle');
