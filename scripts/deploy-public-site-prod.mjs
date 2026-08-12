#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selfTest = process.argv.includes('--self-test');
const dryRun = process.argv.includes('--dry-run');

function walk(dir, files = []) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (relative(dir, path) !== 'runtime-manifest.json') files.push(path);
  }
  return files;
}

function validate({ manifest, approval, artifactDir, now = Date.now() }) {
  const failures = [];
  if (manifest.schema_id !== 'xlooop.public_site_runtime_manifest.v1') failures.push('runtime manifest schema drift');
  if (manifest.artifact_contract !== 'public_site_v1') failures.push('public-site artifact contract drift');
  if (manifest.source_repository !== 'x-ai-front' || manifest.source_path !== 'site') failures.push('public-site source authority drift');
  if (manifest.target_url !== 'https://www.xlooop.com') failures.push('public-site target URL drift');
  if (!/^[0-9a-f]{40}$/.test(manifest.frontend_sha ?? '')) failures.push('invalid frontend SHA');
  if (approval.schema_id !== 'xlooop.public_site_deploy_approval.v1' || approval.status !== 'approved') failures.push('deployment approval missing');
  if (approval.frontend_sha !== manifest.frontend_sha) failures.push('approval frontend SHA mismatch');
  if (approval.cloudflare_pages_project !== 'xlooop-site') failures.push('approval Pages project mismatch');
  if (approval.target_url !== manifest.target_url) failures.push('approval target URL mismatch');
  if (!approval.rollback_deployment_id) failures.push('rollback deployment ID missing');
  if (!Number.isFinite(Date.parse(approval.expires_at)) || Date.parse(approval.expires_at) <= now) failures.push('deployment approval expired');
  if (artifactDir) {
    const listed = new Map(Object.entries(manifest.files ?? {}));
    const actual = walk(artifactDir).map((path) => relative(artifactDir, path).replaceAll('\\', '/'));
    for (const path of actual) {
      if (path === 'runtime-manifest.json') continue;
      if (!listed.has(path)) failures.push(`artifact file not declared: ${path}`);
      else {
        const digest = createHash('sha256').update(readFileSync(resolve(artifactDir, path))).digest('hex');
        if (listed.get(path) !== digest) failures.push(`artifact hash mismatch: ${path}`);
      }
    }
    for (const path of listed.keys()) if (!actual.includes(path)) failures.push(`declared artifact file missing: ${path}`);
  }
  return failures;
}

if (selfTest) {
  const manifest = {
    schema_id: 'xlooop.public_site_runtime_manifest.v1', artifact_contract: 'public_site_v1',
    source_repository: 'x-ai-front', source_path: 'site', target_url: 'https://www.xlooop.com',
    frontend_sha: 'a'.repeat(40), files: {},
  };
  const approval = {
    schema_id: 'xlooop.public_site_deploy_approval.v1', status: 'approved', frontend_sha: 'a'.repeat(40),
    cloudflare_pages_project: 'xlooop-site', target_url: 'https://www.xlooop.com',
    rollback_deployment_id: 'rollback-id', expires_at: '2999-01-01T00:00:00Z',
  };
  const mutated = structuredClone({ manifest, approval });
  mutated.manifest.source_repository = 'x-web';
  mutated.approval.frontend_sha = 'b'.repeat(40);
  mutated.approval.rollback_deployment_id = '';
  const failures = validate(mutated);
  const expected = ['public-site source authority drift', 'approval frontend SHA mismatch', 'rollback deployment ID missing'];
  const observed = expected.filter((failure) => failures.includes(failure));
  if (observed.length === expected.length && failures.length === expected.length) {
    console.log(`SELF-TEST PASS public-site deployment - ${observed.length}/${expected.length} seeded breaches rejected`);
    process.exit(0);
  }
  console.error('SELF-TEST FAIL public-site deployment');
  process.exit(1);
}

const artifactDir = resolve(process.env.XLOOOP_PUBLIC_SITE_ARTIFACT_DIR || '');
const approvalPath = resolve(process.env.XLOOOP_PUBLIC_SITE_DEPLOY_APPROVAL_FILE || '');
if (!process.env.XLOOOP_PUBLIC_SITE_ARTIFACT_DIR || !existsSync(resolve(artifactDir, 'runtime-manifest.json'))) {
  console.error('deploy-public-site-prod · FAIL-CLOSED · XLOOOP_PUBLIC_SITE_ARTIFACT_DIR is missing a runtime manifest');
  process.exit(1);
}
if (!process.env.XLOOOP_PUBLIC_SITE_DEPLOY_APPROVAL_FILE || !existsSync(approvalPath)) {
  console.error('deploy-public-site-prod · FAIL-CLOSED · XLOOOP_PUBLIC_SITE_DEPLOY_APPROVAL_FILE is required');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(resolve(artifactDir, 'runtime-manifest.json'), 'utf8'));
const approval = JSON.parse(readFileSync(approvalPath, 'utf8'));
const failures = validate({ manifest, approval, artifactDir });
if (failures.length) {
  console.error(`deploy-public-site-prod · FAIL-CLOSED · ${failures.join(', ')}`);
  process.exit(1);
}
if (dryRun) {
  console.log(`deploy-public-site-prod · DRY-RUN PASS · frontend=${manifest.frontend_sha} rollback=${approval.rollback_deployment_id}`);
  process.exit(0);
}
const wrangler = resolve(ROOT, 'node_modules/wrangler/bin/wrangler.js');
const result = spawnSync(process.execPath, [wrangler, 'pages', 'deploy', artifactDir,
  '--project-name=xlooop-site', '--branch=main', `--commit-hash=${manifest.frontend_sha}`, '--commit-dirty=false'],
{ cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
if (result.status !== 0) {
  console.error(`deploy-public-site-prod · FAIL-CLOSED · wrangler exited ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log(`deploy-public-site-prod · PASS · frontend=${manifest.frontend_sha}`);
