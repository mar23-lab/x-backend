#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const failures = [];
const warnings = [];

const signal = json('data/cloudflare-deployment-signal.json');
const readiness = json('data/cloud-deployment-readiness.json');
const packageJson = json('package.json');
const plan = text('docs/deployment/CLOUDFLARE_DEPLOYMENT_PLAN.md');
const wrangler = jsonc('wrangler.jsonc');

check('schema', signal.schema_version === 'xlooop.cloudflare_deployment_signal.v1');
check('canonical_pages_direct_upload', signal.canonical_deploy_surface === 'cloudflare_pages_direct_upload');
check('remote_not_release_authority', signal.remote_ci_status === 'not_release_authority');
check('public_not_claimed', signal.public_claim_status === 'not_claimed');
check('github_actions_disabled', readiness.github_actions?.active === false);
check('no_active_workflows', listYamlFiles('.github/workflows').length === 0);
check('preserved_disabled_templates', ['cloudflare-pages.yml', 'cloudflare-feedback-d1.yml', 'smoke.yml'].every((name) => listYamlFiles('deployment/github-actions-disabled').includes(name)));
check('build_prepares_pages_bundle', packageJson.scripts?.build === 'npm run prepare:cloudflare-pages');
check('wrangler_pages_output', wrangler.pages_build_output_dir === 'dist-cloudflare');
check('plan_declares_local_authority', /local Cloudflare\s+deploy wrapper/.test(plan) && plan.includes('Do not restore `.github/workflows/*.yml`'));

const integrations = new Map((signal.remote_integrations || []).map((row) => [row.integration_id, row]));
const workers = integrations.get('cloudflare_workers_builds_xlooop');
check('workers_misbinding_classified', workers?.status === 'known_external_misbinding'
  && workers?.active_as_release_gate === false
  && workers?.check_name === 'Workers Builds: xlooop');
check('workers_resolution_named', Boolean(workers?.required_resolution) && workers?.owner_action_required === true);

for (const gate of ['verify:github-actions-disabled', 'verify:cloud-deployment-readiness', 'verify:cloudflare-deployment-signal', 'verify:hosted-deployment-evidence', 'verify:hosted-ci-runner-health', 'verify:public-production-readiness-hard-stop', 'verify:cloudflare-access-evidence', 'verify:feedback-cloud-smoke', 'verify:commercial-release-truth', 'build']) {
  check(`local_gate:${gate}`, (signal.required_local_evidence || []).includes(gate));
}

if (args.has('--remote')) {
  inspectRemoteCheck(workers?.check_name || 'Workers Builds: xlooop');
}

if (failures.length) {
  console.error('cloudflare-deployment-signal: FAIL');
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  for (const warning of warnings) console.warn(`  WARN ${warning}`);
  process.exit(1);
}

console.log(`cloudflare-deployment-signal: PASS (${signal.canonical_deploy_surface}; remote=${signal.remote_ci_status})`);
for (const warning of warnings) console.warn(`warn: ${warning}`);

function inspectRemoteCheck(checkName) {
  let checkRuns = [];
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const stdout = execFileSync('gh', [
      'api',
      `repos/mar23-lab/Xlooop-XCP-demo/commits/${head}/check-runs`,
      '--jq',
      '.check_runs[] | {name,status,conclusion,details_url}',
    ], { encoding: 'utf8' });
    checkRuns = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    warnings.push(`remote_check_unavailable:${String(error.message || error)}`);
    return;
  }
  const remote = checkRuns.find((run) => run.name === checkName);
  if (!remote) return;
  if (remote.conclusion === 'success') return;
  check('remote_workers_failure_is_classified', remote.conclusion === 'failure' && workersClassified());
}

function workersClassified() {
  const row = (signal.remote_integrations || []).find((item) => item.integration_id === 'cloudflare_workers_builds_xlooop');
  return row?.status === 'known_external_misbinding' && row?.active_as_release_gate === false && row?.classification === 'cloudflare_workers_service_configuration_debt';
}

function json(rel) {
  return JSON.parse(text(rel));
}

function jsonc(rel) {
  const raw = text(rel).replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(raw);
}

function text(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function listYamlFiles(rel) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((name) => /\.ya?ml$/i.test(name)).sort();
}

function check(id, ok) {
  if (!ok) failures.push(id);
}
