#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const remote = process.argv.includes('--remote');
const signal = json('data/cloudflare-deployment-signal.json');
const pkg = json('package.json');
const failures = [];
const warnings = [];
let checkCount = 0;

check(signal.schema_version === 'xlooop.cloudflare_deployment_signal.v2', 'schema');
check(signal.canonical_deploy_surface === 'paired_workers_api_and_react_pages', 'paired_surface');
check(signal.canonical_deploy_script === 'deploy:paired:prod', 'paired_script');
check(signal.remote_ci_status === 'not_release_authority', 'remote_not_authority');
check(signal.public_claim_status === 'hold_pending_live_evidence', 'public_claim_hold');
check(listYamlFiles('.github/workflows').length === 0, 'no_active_workflows');

const pairedCommand = 'node scripts/deploy-paired-prod.mjs';
for (const alias of ['deploy:api', 'deploy:app:prod', 'deploy:paired:prod']) {
  check(pkg.scripts?.[alias] === pairedCommand, `paired_alias:${alias}`);
}
for (const gate of signal.required_local_evidence || []) {
  check(typeof pkg.scripts?.[gate] === 'string', `registered_gate:${gate}`);
}

const integration = (signal.remote_integrations || []).find((row) => row.integration_id === 'cloudflare_workers_builds_xlooop');
check(integration?.active_as_release_gate === false, 'external_workers_not_release_gate');
check(integration?.status === 'external_unratified_signal', 'external_workers_classified');
check(Boolean(integration?.required_resolution), 'external_workers_resolution');

if (remote) inspectRemote(integration?.check_name || 'Workers Builds: xlooop');

console.log(JSON.stringify({
  schema_id: 'xlooop.cloudflare_deployment_signal.verifier.v2',
  status: failures.length ? 'FAIL' : 'PASS',
  canonical_deploy_surface: signal.canonical_deploy_surface,
  remote_ci_status: signal.remote_ci_status,
  check_count: checkCount,
  failure_count: failures.length,
  failures,
  warnings,
}, null, 2));
process.exit(failures.length ? 1 : 0);

function inspectRemote(checkName) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const stdout = execFileSync('gh', ['api', `repos/mar23-lab/Xlooop-XCP-demo/commits/${head}/check-runs`, '--jq', '.check_runs[] | {name,status,conclusion,details_url}'], { encoding: 'utf8' });
    const runs = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const found = runs.find((row) => row.name === checkName);
    if (found && found.conclusion !== 'success') warnings.push(`external_check_non_green:${found.conclusion}`);
  } catch (error) {
    warnings.push(`remote_check_unavailable:${String(error.message || error)}`);
  }
}
function check(ok, id) {
  checkCount += 1;
  if (!ok) failures.push(id);
}
function text(relative) { return readFileSync(path.join(root, relative), 'utf8'); }
function json(relative) { return JSON.parse(text(relative)); }
function listYamlFiles(relative) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).filter((name) => /\.ya?ml$/i.test(name));
}
