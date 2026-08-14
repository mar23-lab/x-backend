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
check(readiness.deployment_topology?.kind === 'paired_worker_api_and_rich_pages', 'paired_topology', 'Topology must be Worker API plus rich UI Pages.');
check(readiness.deployment_topology?.frontend_artifact_contract === 'rich_ui_v3', 'rich_ui_contract', 'The commercial frontend contract must be rich_ui_v3.');
check(readiness.deployment_topology?.frontend_source_spec_class === 'demo_derived_ux_spec', 'demo_spec_classified', 'App.dc.html must remain a non-authoritative UX specification.');
check(readiness.deployment_topology?.production_deploy_allowed_from_spec === false, 'demo_spec_not_deployable', 'The demo-derived UX specification must not be deployable.');
check(readiness.deployment_topology?.frontend_production_source === 'wired/src', 'rich_ui_source', 'wired/src must be the executable commercial source.');
check(readiness.deployment_topology?.frontend_build_output === 'wired/dist-production', 'rich_ui_build_output', 'Only the strict production build may cross the release boundary.');
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
check(/^\s+artifact_contract: rich_ui_v3$/m.test(surfaces) && /^\s+release_input_artifact: wired\/dist-production$/m.test(surfaces), 'rich_ui_authority', 'The deployed app registry must name the strict rich UI v3 release input.');
check(/^\s+serving_artifact: x-backend\/dist-app-pages-release$/m.test(surfaces), 'assembled_serving_artifact', 'The deployed app must be the backend-assembled immutable Pages release.');
check(/^\s+source_spec: project\/App\.dc\.html$/m.test(surfaces) && /^\s+production_deploy_allowed_from_spec: false$/m.test(surfaces), 'demo_spec_not_authority', 'The demo-derived spec must be registered and nondeployable.');
for (const staleMarker of ['react_vite_v2', 'live_legacy_artifact_pending_rich_cutover', 'target_serving_source:', 'serving_artifact: app/dist']) {
  check(!surfaces.includes(staleMarker), `stale_surface_${staleMarker}`, `Stale frontend authority marker must be absent: ${staleMarker}`);
}

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
