#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessPagesDecisionPacket } from './lib/app-pages-release-contract.mjs';
import {
  isDeploymentAuthorizationConsumed,
} from './lib/deployment-authorization-store.mjs';
import { promoteExactPagesDeployment } from './lib/pages-production-promotion.mjs';

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

// F2 · SECURITY-HEADER PARITY AGAINST THE ARTIFACT WE ARE ABOUT TO UPLOAD.
//
// verify-app-security-header-parity.mjs has had an artifact mode and a live mode since it was
// written, and until 260729 NEITHER had a caller: `ci-local` invoked the script's own `--self-test`,
// so the only thing that ever ran was the comparator's controls. The header check against a real
// artifact and against app.xlooop.com had never executed once.
//
// This is the right place for the artifact assertion: the release directory provably exists here, so
// `--require-artifact` cannot degrade into "nothing to check, PASS". Fail-closed before upload.
const verifyHeaders = spawnSync(
  process.execPath,
  [path.join(root, 'scripts/verify-app-security-header-parity.mjs'), '--require-artifact'],
  { cwd: root, env: { ...process.env, XLOOOP_APP_PAGES_RELEASE_DIR: releaseDir }, encoding: 'utf8' },
);
if (verifyHeaders.status !== 0) fail(verifyHeaders.stderr || verifyHeaders.stdout);

const manifest = JSON.parse(readFileSync(path.join(releaseDir, 'release-manifest.json'), 'utf8'));
const packet = JSON.parse(readFileSync(path.resolve(packetPath), 'utf8'));
const orchestratedCutoverId = process.env.XLOOOP_PAIRED_CUTOVER_INTERNAL;
if (!orchestratedCutoverId || orchestratedCutoverId !== packet.cutover_id) {
  fail('standalone Pages production deploy is disabled; use npm run deploy:paired:prod');
}
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
if (!isDeploymentAuthorizationConsumed(root, 'pages', packet.decision.authorization_id)) {
  fail('Pages authorization was not reserved by the paired cutover orchestrator');
}

const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const deploy = spawnSync(
  process.execPath,
  [
    wrangler,
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
  { cwd: root, encoding: 'utf8' },
);
if (deploy.stdout) process.stdout.write(deploy.stdout);
if (deploy.stderr) process.stderr.write(deploy.stderr);
if (deploy.status !== 0) fail(`wrangler pages deploy exited ${String(deploy.status)}`);

// Direct Upload can finish while Cloudflare still keeps a prior deployment as the project's
// canonical production authority. The immutable deployment URL is only evidence that upload
// succeeded; it does not prove app.xlooop.com points at it. Promote the exact uploaded deployment
// through Cloudflare's production rollback/promote endpoint and verify canonical id + source SHA
// before the paired orchestrator starts byte-for-byte live ratification.
try {
  const promotion = await promoteExactPagesDeployment({
    root,
    deploymentOutput: `${deploy.stdout || ''}\n${deploy.stderr || ''}`,
    expectedFrontendSha: manifest.frontend_sha,
  });
  console.log(
    `deploy-app-prod · CANONICAL · deployment=${promotion.deployment_id}`
      + ` frontend=${manifest.frontend_sha}`,
  );
} catch (error) {
  fail(`canonical Pages promotion failed: ${error instanceof Error ? error.message : String(error)}`);
}

// F2 · LIVE header parity — "the live check is the teeth" (that gate's own header). Reported, not
// fail-closed: the upload has already happened, so exiting non-zero here would only hide the deploy
// result. Cloudflare edge propagation is not instantaneous, which is exactly why this is advisory
// and why it prints the drift instead of pretending nothing ran.
const liveHeaders = spawnSync(
  process.execPath,
  [path.join(root, 'scripts/verify-app-security-header-parity.mjs'), '--live', 'https://app.xlooop.com'],
  { cwd: root, encoding: 'utf8' },
);
if (liveHeaders.status !== 0) {
  console.error('deploy-app-prod · LIVE HEADER PARITY DRIFT (advisory — the deploy already landed):');
  console.error((liveHeaders.stdout || '') + (liveHeaders.stderr || ''));
  console.error('  re-run after edge propagation: npm run verify:app-security-headers:live');
} else {
  console.log('deploy-app-prod · live security-header parity PASS');
}

console.log(
  `deploy-app-prod · DEPLOYED · frontend=${manifest.frontend_sha} backend=${manifest.backend_sha}`
  + ' · post-deploy ratification and live probes are still required',
);
