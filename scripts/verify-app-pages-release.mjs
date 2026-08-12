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
  releaseManifestDigest,
  verifyStaticArtifactFiles,
} from './lib/app-pages-release-contract.mjs';
import {
  localMigrationHead,
  readCandidateDeploymentContract,
} from './lib/candidate-deployment-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.resolve(process.env.XLOOOP_APP_PAGES_RELEASE_DIR || path.join(root, 'dist-app-pages-release'));
const manifestPath = path.join(releaseDir, 'release-manifest.json');
const problems = [];
const selfTest = process.argv.includes('--self-test');

function runSelfTest() {
  const candidateSchemaHead = String(localMigrationHead(root));
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

  const reactRoot = path.join(testRoot, 'react');
  mkdirSync(path.join(reactRoot, 'assets'), { recursive: true });
  writeFileSync(path.join(reactRoot, 'index.html'), '<div id="root"></div>');
  writeFileSync(path.join(reactRoot, 'assets/app.js'), '');
  const reactManifest = {
    schema_id: 'xlooop.frontend_runtime_manifest.v2',
    runtime_class: 'production',
    production_cutover_approved: true,
    require_contract_handshake: true,
    api_base: 'https://api.xlooop.com',
    frontend_sha: frontendSha,
    expected_backend_sha: backendSha,
    expected_contract_hash: contractHash,
    expected_schema_head: 89,
    expected_environment: 'production',
    expected_authority: 'production',
    expected_feature_posture: posture,
    files: hashReleaseFiles(reactRoot, new Set(['runtime-manifest.json'])),
  };
  writeFileSync(path.join(reactRoot, 'runtime-manifest.json'), `${JSON.stringify(reactManifest)}\n`);

  const richRoot = path.join(testRoot, 'rich');
  mkdirSync(path.join(richRoot, 'vendor'), { recursive: true });
  for (const [file, contents] of Object.entries({
    'index.html': '<script src="./runtime-config.js"></script><script src="./app-logic.js" data-dc-script></script>',
    'runtime-config.js': '',
    'app-logic.js': '',
    'clerk-boot.js': '',
    'contract-meta.js': contractHash,
    'live-data.js': '',
    'authority-consent.js': '',
    'runtime-ui.css': '',
    'support.js': '',
    'vendor/runtime.js': '',
  })) writeFileSync(path.join(richRoot, file), contents);
  const richManifest = {
    schema_id: 'xlooop.frontend_runtime_manifest.v3',
    artifact_contract: 'rich_ui_v3',
    runtime_class: 'production',
    production_cutover_approved: true,
    require_contract_handshake: true,
    api_base: 'https://api.xlooop.com',
    frontend_sha: frontendSha,
    expected_backend_sha: backendSha,
    expected_contract_hash: contractHash,
    expected_schema_head: 89,
    expected_environment: 'production',
    expected_authority: 'production',
    expected_feature_posture: posture,
    files: hashReleaseFiles(richRoot, new Set(['runtime-manifest.json'])),
  };
  writeFileSync(path.join(richRoot, 'runtime-manifest.json'), `${JSON.stringify(richManifest)}\n`);

  const parsed = parseFrontendReleaseArtifact(testRoot);
  const valid = assessFrontendReleaseArtifact(parsed, { frontend_sha: frontendSha, backend_sha: backendSha });
  const wrongBackend = assessFrontendReleaseArtifact(parsed, {
    frontend_sha: frontendSha,
    backend_sha: 'd'.repeat(40),
  });
  const staticProblems = verifyStaticArtifactFiles(testRoot, contractHash);
  const reactParsed = parseFrontendReleaseArtifact(reactRoot);
  const validReact = assessFrontendReleaseArtifact(reactParsed, {
    frontend_sha: frontendSha,
    backend_sha: backendSha,
    contract_hash: contractHash,
  });
  const wrongReactContract = assessFrontendReleaseArtifact(reactParsed, {
    frontend_sha: frontendSha,
    backend_sha: backendSha,
    contract_hash: 'd'.repeat(64),
  });
  const wrongReactSchema = assessFrontendReleaseArtifact(reactParsed, {
    frontend_sha: frontendSha,
    backend_sha: backendSha,
    contract_hash: contractHash,
    schema_head: 100,
  });
  const wrongReactPosture = assessFrontendReleaseArtifact(reactParsed, {
    frontend_sha: frontendSha,
    backend_sha: backendSha,
    contract_hash: contractHash,
    feature_posture: { ...posture, current_work_projection: true },
  });
  const pilotApiBase = 'https://api-test.xlooop.com';
  const pilotReact = {
    ...reactParsed,
    build_mode: 'staging',
    production_cutover_approved: false,
    api_base: pilotApiBase,
    environment: 'pilot-shadow',
    authority: 'shadow',
  };
  const validPilotReact = assessFrontendReleaseArtifact(pilotReact, {
    frontend_sha: frontendSha,
    backend_sha: backendSha,
    contract_hash: contractHash,
    environment: 'pilot-shadow',
    authority: 'shadow',
    api_base: pilotApiBase,
  });
  const pilotReactRejectedWithoutExplicitTarget = assessFrontendReleaseArtifact(pilotReact, {
    frontend_sha: frontendSha,
    backend_sha: backendSha,
    contract_hash: contractHash,
  });
  const reactStaticProblems = verifyStaticArtifactFiles(reactRoot, contractHash);
  mkdirSync(path.join(reactRoot, '_worker.js'), { recursive: true });
  writeFileSync(path.join(reactRoot, '_worker.js', 'index.js'), 'export default {};');
  writeFileSync(path.join(reactRoot, '_routes.json'), '{}');
  writeFileSync(path.join(reactRoot, 'release-manifest.json'), '{}');
  const assembledReactProblems = verifyStaticArtifactFiles(reactRoot, contractHash);
  writeFileSync(path.join(reactRoot, 'assets/app.js'), 'tampered-after-manifest');
  const tamperedReactProblems = verifyStaticArtifactFiles(reactRoot, contractHash);
  writeFileSync(path.join(reactRoot, 'assets/app.js'), '');
  const richParsed = parseFrontendReleaseArtifact(richRoot);
  const validRich = assessFrontendReleaseArtifact(richParsed, {
    frontend_sha: frontendSha,
    backend_sha: backendSha,
    contract_hash: contractHash,
  });
  const richStaticProblems = verifyStaticArtifactFiles(richRoot, contractHash);
  writeFileSync(path.join(richRoot, 'app-logic.js'), 'tampered-after-manifest');
  const tamperedRichProblems = verifyStaticArtifactFiles(richRoot, contractHash);
  const hashes = hashReleaseFiles(testRoot);
  const manifest = {
    schema_id: 'xlooop.app_pages_release_manifest.v1',
    artifact_contract: 'legacy_wired_v1',
    frontend_sha: frontendSha,
    backend_sha: backendSha,
    contract_hash: contractHash,
    schema_head: 89,
    environment: 'production',
    authority: 'production',
    api_base: 'https://api.xlooop.com',
    feature_posture: posture,
    files: hashes,
  };
  manifest.artifact_digest = releaseManifestDigest(manifest);
  const validManifest = assessReleaseManifest(manifest, hashes);
  const tamperedManifest = assessReleaseManifest(manifest, { ...hashes, 'index.html': 'd'.repeat(64) });
  const digestDriftManifest = assessReleaseManifest({ ...manifest, artifact_digest: '0'.repeat(64) }, hashes);
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
  const productionDeployment = readCandidateDeploymentContract(root, {
    XLOOOP_SCHEMA_HEAD: candidateSchemaHead,
  });
  const pilotShadowDeployment = readCandidateDeploymentContract(root, {
    XLOOOP_SCHEMA_HEAD: candidateSchemaHead,
    XLOOOP_DEPLOYMENT_WRANGLER_CONFIG: 'wrangler.pilot-shadow.toml',
  });
  const unknownDeploymentConfigRejected = (() => {
    try {
      readCandidateDeploymentContract(root, {
        XLOOOP_SCHEMA_HEAD: candidateSchemaHead,
        XLOOOP_DEPLOYMENT_WRANGLER_CONFIG: '../wrangler.toml',
      });
      return false;
    } catch {
      return true;
    }
  })();
  const checks = [
    ['valid artifact', valid.ok],
    ['wrong backend rejected', !wrongBackend.ok && wrongBackend.problems.includes('backend_sha_mismatch')],
    ['required files valid', staticProblems.length === 0],
    ['React/Vite v2 artifact is valid', validReact.ok],
    ['React/Vite v2 contract drift is rejected',
      !wrongReactContract.ok && wrongReactContract.problems.includes('contract_hash_mismatch')],
    ['React/Vite v2 schema drift is rejected',
      !wrongReactSchema.ok && wrongReactSchema.problems.includes('schema_head_mismatch')],
    ['React/Vite v2 feature posture drift is rejected',
      !wrongReactPosture.ok && wrongReactPosture.problems.includes('feature_posture_mismatch')],
    ['pilot-shadow artifact is valid only against the explicit pilot target', validPilotReact.ok],
    ['pilot-shadow artifact cannot claim production cutover approval',
      !assessFrontendReleaseArtifact(
        { ...pilotReact, production_cutover_approved: true },
        {
          frontend_sha: frontendSha,
          backend_sha: backendSha,
          contract_hash: contractHash,
          environment: 'pilot-shadow',
          authority: 'shadow',
          api_base: pilotApiBase,
        },
      ).ok],
    ['pilot-shadow artifact is rejected by the production-default contract',
      !pilotReactRejectedWithoutExplicitTarget.ok
        && pilotReactRejectedWithoutExplicitTarget.problems.includes('api_base')
        && pilotReactRejectedWithoutExplicitTarget.problems.includes('environment')
        && pilotReactRejectedWithoutExplicitTarget.problems.includes('authority')],
    ['React/Vite v2 static files are valid', reactStaticProblems.length === 0],
    ['React/Vite v2 frontend hashes remain valid after backend-owned release assembly',
      assembledReactProblems.length === 0],
    ['React/Vite v2 post-manifest asset mutation is rejected',
      tamperedReactProblems.includes('runtime_manifest_file_hashes')],
    ['rich UI v3 artifact is valid', validRich.ok && richStaticProblems.length === 0],
    ['rich UI v3 post-manifest logic mutation is rejected',
      tamperedRichProblems.includes('runtime_manifest_file_hashes')],
    ['valid manifest', validManifest.ok],
    ['tampered file rejected', !tamperedManifest.ok && tamperedManifest.problems.includes('file_hashes')],
    ['tampered release digest rejected',
      !digestDriftManifest.ok && digestDriftManifest.problems.includes('artifact_digest_mismatch')],
    ['randomized route comments normalize identically', normalizedA === normalizedB],
    ['normalized marker is stable', normalizePagesFunctionsBundle(normalizedA) === normalizedA],
    ['normalized marker is present once', normalizedA.split(PAGES_FUNCTIONS_ROUTE_SOURCE_MARKER).length === 2],
    ['duplicate route comments rejected', duplicateRouteCommentsRejected],
    ['unknown Wrangler tmp comment rejected', unknownTmpCommentRejected],
    ['production deployment contract remains production-only',
      productionDeployment.worker_name === 'xlooop-api'
        && productionDeployment.environment === 'production'
        && productionDeployment.authority === 'production'],
    ['pilot-shadow deployment contract is explicitly allowlisted',
      pilotShadowDeployment.worker_name === 'xlooop-api-pilot-shadow'
        && pilotShadowDeployment.environment === 'pilot-shadow'
        && pilotShadowDeployment.authority === 'shadow'
        && pilotShadowDeployment.api_base === 'https://api-test.xlooop.com'],
    ['unknown deployment config is rejected', unknownDeploymentConfigRejected],
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
  const deploymentConfigByEnvironment = {
    production: 'wrangler.toml',
    'pilot-shadow': 'wrangler.pilot-shadow.toml',
  };
  const deploymentConfig = deploymentConfigByEnvironment[config.environment];
  if (!deploymentConfig) throw new Error(`unsupported release environment ${config.environment}`);
  const candidateDeployment = readCandidateDeploymentContract(root, {
    ...process.env,
    XLOOOP_DEPLOYMENT_WRANGLER_CONFIG: deploymentConfig,
  });
  const artifact = assessFrontendReleaseArtifact(config, {
    frontend_sha: manifest.frontend_sha,
    backend_sha: backendSha,
    contract_hash: contract.contract_hash,
    schema_head: candidateDeployment.schema_head,
    api_base: candidateDeployment.api_base,
    environment: candidateDeployment.environment,
    authority: candidateDeployment.authority,
    feature_posture: candidateDeployment.feature_posture,
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
  if (manifest.deployment_worker !== candidateDeployment.worker_name) problems.push('manifest_deployment_worker_mismatch');
  if (manifest.wrangler_config !== candidateDeployment.wrangler_config) problems.push('manifest_wrangler_config_mismatch');
  const manifestAssessment = assessReleaseManifest(manifest, hashReleaseFiles(releaseDir), {
    environment: candidateDeployment.environment,
    authority: candidateDeployment.authority,
    api_base: candidateDeployment.api_base,
    deployment_worker: candidateDeployment.worker_name,
    wrangler_config: candidateDeployment.wrangler_config,
  });
  problems.push(...manifestAssessment.problems);
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}

if (problems.length) {
  console.error(`verify-app-pages-release · FAIL-CLOSED · ${[...new Set(problems)].join(',')}`);
  process.exit(1);
}
console.log('verify-app-pages-release · PASS · exact frontend/backend artifact and Pages Functions bundle');
