#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readiness = json('data/cloud-deployment-readiness.json');
const pkg = json('package.json');
const findings = [];
let checkCount = 0;

check(readiness.schema_version === 'xlooop.cloud_deployment_readiness.v2', 'schema_version', 'Current paired-deployment schema is required.');
check(readiness.canonical_public_domains?.app === 'https://app.xlooop.com', 'app_domain', 'Canonical app domain must be explicit.');
check(readiness.canonical_public_domains?.api === 'https://api.xlooop.com', 'api_domain', 'Canonical API domain must be explicit.');
check(readiness.public_self_serve?.status === 'hold_pending_live_evidence', 'public_claim_hold', 'Deployment readiness must not imply public self-serve authority.');
check(readiness.deployment_topology?.kind === 'paired_worker_api_and_react_pages', 'paired_topology', 'Topology must be Worker API plus React Pages.');
check(readiness.deployment_topology?.single_mutation_command === 'deploy:paired:prod', 'single_mutation_command', 'One paired production mutation command is required.');
check(readiness.deployment_topology?.standalone_api_or_pages_production_deploy_allowed === false, 'no_standalone_production_deploy', 'Standalone production mutation must be forbidden.');
check(readiness.deployment_topology?.compensating_rollback_required === true, 'compensating_rollback', 'Failed pair ratification must roll back.');
check(readiness.github_actions?.active === false, 'github_actions_non_authoritative', 'Unavailable GitHub Actions must remain non-authoritative.');
check(listYamlFiles('.github/workflows').length === 0, 'no_active_workflows', 'No active GitHub workflow YAML is allowed under this posture.');

const pairedCommand = 'node scripts/deploy-paired-prod.mjs';
for (const alias of ['deploy:api', 'deploy:app:prod', 'deploy:paired:prod']) {
  check(pkg.scripts?.[alias] === pairedCommand, `paired_alias_${alias}`, `${alias} must converge on the paired orchestrator.`);
}
for (const gate of readiness.required_local_gates || []) {
  check(typeof pkg.scripts?.[gate] === 'string', `registered_gate_${gate}`, `Required gate ${gate} must be registered in package.json.`);
}

for (const relative of [
  'scripts/deploy-paired-prod.mjs',
  'scripts/deploy-app-prod.mjs',
  'scripts/prepare-app-pages-release.mjs',
  'scripts/verify-app-pages-release.mjs',
  'scripts/verify-app-pages-live.mjs',
  'scripts/verify-frontend-pair-before-api-deploy.mjs',
  'scripts/verify-rollback-target-authority.mjs',
  'scripts/lib/paired-cutover-contract.mjs',
  'docs/deployment/APP_PAGES_RELEASE_CONTRACT.md',
  'docs/deployment/DEPLOYED_SURFACES.yml',
]) {
  check(existsSync(path.join(root, relative)), `exists_${relative}`, `${relative} must exist.`);
}

const paired = text('scripts/deploy-paired-prod.mjs');
for (const marker of ['reserveAuthorizations', 'ratifyApi', 'ratifyPair', 'rollbackPages', 'rollbackApi', 'verify-rollback-target-authority.mjs']) {
  check(paired.includes(marker), `paired_contract_${marker}`, `Paired deploy must include ${marker}.`);
}
const appDeploy = text('scripts/deploy-app-prod.mjs');
check(appDeploy.includes('standalone Pages production deploy is disabled'), 'pages_fail_closed', 'Pages deploy must refuse a standalone production mutation.');
const surfaces = text('docs/deployment/DEPLOYED_SURFACES.yml');
check(/^\s+artifact_contract: react_vite_v2$/m.test(surfaces) && /^\s+serving_source: app$/m.test(surfaces), 'react_ui_authority', 'Current deployed app artifact must remain explicit until cutover.');
check(!/^\s+serving_source: wired$/m.test(surfaces), 'wired_not_deployed', 'Raw wired source must not be declared as the deployed serving source.');

const report = {
  schema_id: 'xlooop.cloud_deployment_readiness.verifier.v2',
  status: findings.length ? 'FAIL' : 'PASS',
  topology: readiness.deployment_topology?.kind,
  public_self_serve_status: readiness.public_self_serve?.status,
  check_count: checkCount,
  failure_count: findings.length,
  failures: findings,
};
console.log(JSON.stringify(report, null, 2));
process.exit(findings.length ? 1 : 0);

function check(ok, id, message) {
  checkCount += 1;
  if (!ok) findings.push({ id, message });
}
function text(relative) { return readFileSync(path.join(root, relative), 'utf8'); }
function json(relative) { return JSON.parse(text(relative)); }
function listYamlFiles(relative) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).filter((name) => /\.ya?ml$/i.test(name));
}
