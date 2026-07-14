#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const readinessPath = path.join(repoRoot, 'data', 'cloud-deployment-readiness.json');
const claimPosturePath = path.join(repoRoot, 'data', 'public-private-claim-posture.json');
const activeWorkflowDir = path.join(repoRoot, '.github', 'workflows');
const localDeployScript = path.join(repoRoot, 'scripts', 'deploy-cloudflare-pages-local.mjs');
const feedbackCloudSmokeScript = path.join(repoRoot, 'scripts', 'verify-feedback-cloud-smoke.mjs');
const hostedDeploymentEvidencePath = path.join(repoRoot, 'data', 'hosted-deployment-evidence.json');
const hostedDeploymentEvidenceScript = path.join(repoRoot, 'scripts', 'verify-hosted-deployment-evidence.mjs');
const hostedCiRunnerHealthPath = path.join(repoRoot, 'data', 'hosted-ci-runner-health.json');
const hostedCiRunnerHealthScript = path.join(repoRoot, 'scripts', 'verify-hosted-ci-runner-health.mjs');
const publicProductionHardStopScript = path.join(repoRoot, 'scripts', 'verify-public-production-readiness-hard-stop.mjs');
const externalCapabilityDefaultHardStopScript = path.join(repoRoot, 'scripts', 'verify-external-capability-default-hard-stop.mjs');
const externalCapabilityLivePrereqsScript = path.join(repoRoot, 'scripts', 'verify-external-capability-live-prereqs.mjs');
const apiMcpLiveCanaryHardStopScript = path.join(repoRoot, 'scripts', 'verify-api-mcp-live-canary-hard-stop.mjs');
const liveEvidenceAuthorityMatrixScript = path.join(repoRoot, 'scripts', 'verify-live-evidence-authority-matrix.mjs');
const cloudflareSignalScript = path.join(repoRoot, 'scripts', 'verify-cloudflare-deployment-signal.mjs');
const retrospectiveCloseoutScript = path.join(repoRoot, 'scripts', 'verify-retrospective-closeout-composed.mjs');
const packageJsonPath = path.join(repoRoot, 'package.json');

const readiness = readJson(readinessPath);
const claimPosture = readJson(claimPosturePath);
const packageJson = readJson(packageJsonPath);
const findings = [];

check(readiness.schema_version === 'xlooop.cloud_deployment_readiness.v1', 'schema_version', 'cloud readiness schema must be xlooop.cloud_deployment_readiness.v1');
check(readiness.canonical_public_domain === 'xlooop.com', 'canonical_domain', 'canonical public domain must be xlooop.com');
check(Array.isArray(readiness.allowed_environments), 'allowed_environments_present', 'allowed_environments must be declared');
check(arrayEquals(readiness.allowed_environments || [], ['dev', 'test']), 'allowed_environments_exact', 'only dev and test environments are allowed now');
check(readiness.github_actions?.active === false, 'github_actions_inactive', 'GitHub Actions must be inactive while unpaid/unavailable');
check(readiness.github_actions?.canonical_deploy === 'local_cloudflare_direct_upload', 'canonical_deploy_local_cloudflare', 'Cloudflare direct upload/local wrapper must be canonical while GitHub Actions is inactive');
check(listYamlFiles(activeWorkflowDir).length === 0, 'no_active_github_actions_workflows', 'No active .github/workflows YAML files are allowed while GitHub Actions is inactive');
check(fs.existsSync(localDeployScript) && fs.readFileSync(localDeployScript, 'utf8').includes('writeDeploymentReceipt'), 'local_deploy_receipt_writer', 'local Cloudflare deploy must write deployment receipts');
check(fs.existsSync(feedbackCloudSmokeScript), 'feedback_cloud_smoke_verifier', 'feedback cloud smoke verifier must exist');
check(fs.existsSync(hostedDeploymentEvidencePath), 'hosted_deployment_evidence_contract', 'hosted deployment evidence contract must exist');
check(fs.existsSync(hostedDeploymentEvidenceScript), 'hosted_deployment_evidence_verifier', 'hosted deployment evidence verifier must exist');
check(fs.existsSync(hostedCiRunnerHealthPath), 'hosted_ci_runner_health_contract', 'hosted CI runner-health evidence contract must exist');
check(fs.existsSync(hostedCiRunnerHealthScript), 'hosted_ci_runner_health_verifier', 'hosted CI runner-health verifier must exist');
check(fs.existsSync(publicProductionHardStopScript), 'public_production_hard_stop_verifier', 'public production readiness hard-stop verifier must exist');
check(fs.existsSync(externalCapabilityDefaultHardStopScript), 'external_capability_default_hard_stop_verifier', 'external capability default hard-stop verifier must exist');
check(fs.existsSync(externalCapabilityLivePrereqsScript), 'external_capability_live_prereqs_verifier', 'external capability live-prerequisites verifier must exist');
check(fs.existsSync(apiMcpLiveCanaryHardStopScript), 'api_mcp_live_canary_hard_stop_verifier', 'API/MCP live canary hard-stop verifier must exist');
check(fs.existsSync(liveEvidenceAuthorityMatrixScript), 'live_evidence_authority_matrix_verifier', 'live evidence authority matrix verifier must exist');
check(fs.existsSync(cloudflareSignalScript), 'cloudflare_signal_verifier', 'Cloudflare remote/local signal verifier must exist');
check(fs.existsSync(retrospectiveCloseoutScript), 'retrospective_closeout_composed_verifier', 'composed retrospective closeout verifier must exist');
check(packageJson.scripts?.build === 'npm run prepare:cloudflare-pages', 'cloudflare_default_build_script', 'default npm build must prepare the safe Cloudflare Pages test bundle');
check(packageJson.scripts?.['prepare:cloudflare-pages'] === 'node scripts/prepare-cloudflare-pages.mjs', 'cloudflare_prepare_script', 'prepare:cloudflare-pages must run the Pages bundle preparer');
check((readiness.github_actions?.required_local_gates || []).includes('verify:feedback-cloud-smoke'), 'feedback_cloud_smoke_required_gate', 'cloud readiness must require feedback cloud smoke');
check((readiness.github_actions?.required_local_gates || []).includes('verify:cloudflare-deployment-signal'), 'cloudflare_signal_required_gate', 'cloud readiness must require Cloudflare deployment signal verification');
check((readiness.github_actions?.required_local_gates || []).includes('verify:hosted-deployment-evidence'), 'hosted_deployment_evidence_required_gate', 'cloud readiness must require hosted deployment evidence verification');
check((readiness.github_actions?.required_local_gates || []).includes('verify:hosted-ci-runner-health'), 'hosted_ci_runner_health_required_gate', 'cloud readiness must require hosted CI runner-health classification');
check((readiness.github_actions?.required_local_gates || []).includes('verify:public-production-readiness-hard-stop'), 'public_production_hard_stop_required_gate', 'cloud readiness must require public production hard-stop verification');
check((readiness.github_actions?.required_local_gates || []).includes('verify:external-capability-default-hard-stop'), 'external_capability_default_hard_stop_required_gate', 'cloud readiness must require external capability default hard-stop verification');
check((readiness.github_actions?.required_local_gates || []).includes('verify:external-capability-live-prereqs'), 'external_capability_live_prereqs_required_gate', 'cloud readiness must require external capability live-prerequisites verification');
check((readiness.github_actions?.required_local_gates || []).includes('verify:api-mcp-live-canary-hard-stop'), 'api_mcp_live_canary_hard_stop_required_gate', 'cloud readiness must require API/MCP live canary hard-stop verification');
check((readiness.github_actions?.required_local_gates || []).includes('verify:live-evidence-authority-matrix'), 'live_evidence_authority_matrix_required_gate', 'cloud readiness must require centralized live evidence authority matrix verification');
check((readiness.github_actions?.required_local_gates || []).includes('verify:retrospective-closeout-composed'), 'retrospective_closeout_required_gate', 'cloud readiness must require retrospective closeout composed gate');
for (const blocked of ['customer-feedback', 'feedback', 'staging', 'production']) {
  check((readiness.blocked_environment_names || []).includes(blocked), `blocked_${blocked}`, `${blocked} must be explicitly blocked as an active environment name`);
}

const allEnvironments = (readiness.surfaces || []).flatMap((surface) =>
  (surface.environments || []).map((environment) => ({ surface, environment })),
);
check(allEnvironments.length === 4, 'surface_environment_count', 'Xlooop and XCP must each declare dev and test');

for (const { surface, environment } of allEnvironments) {
  check(['dev', 'test'].includes(environment.environment), `${surface.surface_id}_${environment.environment}_name`, 'surface environment must be dev or test');
  check(Boolean(environment.domain), `${surface.surface_id}_${environment.environment}_domain`, 'surface environment must declare a domain');
  check(!/customer-feedback|feedback\.xlooop\.com|staging|production/.test(environment.domain), `${surface.surface_id}_${environment.environment}_domain_allowed`, 'domain must not use retired customer-feedback/feedback/staging/production naming');
  check(Boolean(environment.access), `${surface.surface_id}_${environment.environment}_access`, 'surface environment must declare access control');
  check(Boolean(environment.data_posture), `${surface.surface_id}_${environment.environment}_data_posture`, 'surface environment must declare data posture');
  check(Boolean(environment.operator_mode), `${surface.surface_id}_${environment.environment}_operator_mode`, 'surface environment must declare operator mode');
}

const testXlooop = allEnvironments.find(({ surface, environment }) => surface.surface_id === 'xlooop' && environment.environment === 'test')?.environment;
check(testXlooop?.domain === 'test.xlooop.com', 'xlooop_test_domain', 'customer feedback environment must be test.xlooop.com');
check(testXlooop?.operator_mode === 'watch_or_proposal_only_by_default', 'xlooop_test_operator_default', 'test.xlooop.com must default to watch/proposal-only');
check(/owner_approved|redacted/.test(testXlooop?.data_posture || ''), 'xlooop_test_data_posture', 'test.xlooop.com must use redacted or owner-approved data only');

const accessPolicy = readiness.access_policy || {};
check(accessPolicy.access_code?.security_role === 'invitation_routing_hint_not_authentication', 'base64_code_not_auth', 'base64-style access codes must not be treated as authentication');
check((accessPolicy.access_code?.required_controls || []).includes('cloudflare_access_identity'), 'cloudflare_access_required', 'Cloudflare Access identity is required in addition to access code');
check(accessPolicy.xcp_second_level_access?.enabled_by === 'admin_per_user_entitlement', 'xcp_second_level_admin_switch', 'XCP second-level access must be admin-enabled per user');

const retiredDomains = readiness.retired_after_launch_domains || [];
check(retiredDomains.some((row) => row.domain === 'xlooop.ai' && /redirect|remove/.test(row.disposition || '')), 'xlooop_ai_retirement', 'xlooop.ai must be retired or redirected after xlooop.com launch');

const postureText = JSON.stringify(claimPosture);
check(postureText.includes('production SaaS fully operating live MB-P') || postureText.includes('production SaaS'), 'production_saas_blocked_claim', 'claim posture must block production SaaS claims');
check(postureText.includes('test.xlooop.com'), 'claim_posture_test_domain', 'claim posture must mention test.xlooop.com');

if (findings.length) {
  console.error('cloud-deployment-readiness: FAIL');
  for (const finding of findings) console.error(`  FAIL ${finding.id}: ${finding.message}`);
  process.exit(1);
}

console.log('cloud-deployment-readiness: PASS (dev/test, xlooop.com canonical, test.xlooop.com feedback, XCP second-level gated)');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function check(ok, id, message) {
  if (!ok) findings.push({ id, message });
}

function arrayEquals(actual, expected) {
  return actual.length === expected.length && expected.every((value, index) => actual[index] === value);
}

function listYamlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /\.(ya?ml)$/i.test(name));
}
