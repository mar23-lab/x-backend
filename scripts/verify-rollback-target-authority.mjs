#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontendReleaseHtml, parseReactRuntimeManifest } from './lib/app-pages-release-contract.mjs';
import {
  assessRollbackAuthorityEvidence,
  rollbackAuthorityValues,
} from './lib/rollback-target-authority-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

function runWrangler(args) {
  const cli = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_LOG: 'none' },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `wrangler exited ${result.status}`).trim());
  }
  return JSON.parse(result.stdout);
}

function deploymentUrl(row) {
  const urls = rollbackAuthorityValues(row, ['url']);
  const raw = urls.find(Boolean);
  if (!raw) throw new Error('rollback Pages deployment has no URL');
  return /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, '') : `https://${raw.replace(/\/+$/, '')}`;
}

async function readFrontendIdentity(base) {
  const manifestResponse = await fetch(`${base}/runtime-manifest.json?rollback_probe=${Date.now()}`, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (manifestResponse.ok) return parseReactRuntimeManifest(await manifestResponse.json());
  const response = await fetch(`${base}/?rollback_probe=${Date.now()}`, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`rollback Pages deployment returned ${response.status}`);
  return parseFrontendReleaseHtml(await response.text());
}

async function main() {
  const apiPath = process.env.XLOOOP_AUTHORITY_DECISION_PACKET;
  const pagesPath = process.env.XLOOOP_APP_PAGES_DECISION_PACKET;
  if (!apiPath || !pagesPath) throw new Error('both authority decision packet paths are required');
  if (!existsSync(apiPath) || !existsSync(pagesPath)) throw new Error('authority decision packet not found');
  const api = JSON.parse(readFileSync(path.resolve(apiPath), 'utf8'));
  const pages = JSON.parse(readFileSync(path.resolve(pagesPath), 'utf8'));
  const expected = {
    worker_version_id: api.rollback.cloudflare_version_id,
    backend_sha: api.rollback.target_sha,
    pages_deployment_id: pages.rollback.cloudflare_deployment_id,
    frontend_sha: pages.rollback.frontend_sha,
  };
  const workerVersion = runWrangler([
    'versions', 'view', expected.worker_version_id, '--config', 'wrangler.toml', '--json',
  ]);
  const pagesDeployments = runWrangler([
    'pages', 'deployment', 'list', '--project-name', 'xlooop-app', '--environment', 'production', '--json',
  ]);
  const assessment = assessRollbackAuthorityEvidence(workerVersion, pagesDeployments, expected);
  if (!assessment.ok) throw new Error(assessment.problems.join(','));
  const identity = await readFrontendIdentity(deploymentUrl(assessment.pages));
  if (identity.frontend_sha !== expected.frontend_sha) throw new Error('rollback_pages_live_frontend_sha');
  if (pages.rollback.backend_sha && identity.backend_sha !== pages.rollback.backend_sha) {
    throw new Error('rollback_pages_live_backend_sha');
  }
  console.log(
    `verify-rollback-target-authority · PASS · worker=${expected.backend_sha}`
      + ` pages=${expected.frontend_sha}`,
  );
}

function selfTest() {
  const expected = {
    worker_version_id: '5c20d49c-957b-4a89-8379-7e4bb1bde936',
    backend_sha: 'a'.repeat(40),
    pages_deployment_id: 'de7eac0b-3b4e-4144-830f-659a291f7e8c',
    frontend_sha: 'b'.repeat(40),
  };
  const worker = {
    id: expected.worker_version_id,
    resources: { bindings: [{ name: 'BUILD_SHA', text: expected.backend_sha }] },
  };
  const pages = [{
    id: expected.pages_deployment_id,
    url: 'rollback.pages.dev',
    deployment_trigger: { metadata: { commit_hash: expected.frontend_sha } },
  }];
  const checks = [
    ['exact rollback pair passes', assessRollbackAuthorityEvidence(worker, pages, expected).ok],
    ['unrelated Worker version fails', assessRollbackAuthorityEvidence({ ...worker, id: 'other' }, pages, expected).problems.includes('worker_version_id')],
    ['wrong Worker build fails', assessRollbackAuthorityEvidence({ ...worker, resources: { bindings: [{ name: 'BUILD_SHA', text: 'c'.repeat(40) }] } }, pages, expected).problems.includes('worker_version_backend_sha')],
    ['wrong Pages commit fails', assessRollbackAuthorityEvidence(worker, [{ ...pages[0], deployment_trigger: { metadata: { commit_hash: 'c'.repeat(40) } } }], expected).problems.includes('pages_deployment_frontend_sha')],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (failed.length) throw new Error(`${failed.length}/${checks.length} rollback authority checks failed`);
  console.log(`verify-rollback-target-authority self-test PASS · ${checks.length - failed.length}/${checks.length}`);
}

try {
  if (SELF_TEST) selfTest();
  else await main();
} catch (error) {
  console.error(`verify-rollback-target-authority · FAIL-CLOSED · ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
