#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const findings = [];

const files = {
  cloudPlan: 'docs/deployment/CLOUDFLARE_DEPLOYMENT_PLAN.md',
  accessChecklist: 'docs/deployment/CLOUDFLARE_ACCESS_EVIDENCE_CHECKLIST.md',
  tenantProof: 'docs/deployment/TENANT_ENTITLEMENT_PROOF.md',
  cloudEnv: 'deployment/cloudflare/environments.json',
  tenantExample: 'deployment/cloudflare/tenant-entitlements.example.json',
  safeExportExample: 'deployment/cloudflare/customer-safe-export-manifest.example.json',
  wrangler: 'wrangler.jsonc',
  workflow: 'deployment/github-actions-disabled/cloudflare-pages.yml',
  prepareScript: 'scripts/prepare-cloudflare-pages.mjs',
  localDeployScript: 'scripts/deploy-cloudflare-pages-local.mjs',
  accessProvisioner: 'scripts/provision-cloudflare-pages-access.mjs',
  actionsInfraVerifier: 'scripts/verify-github-actions-runner-infra.mjs',
  actionsDisabledVerifier: 'scripts/verify-github-actions-disabled.mjs',
  remoteAccessVerifier: 'scripts/verify-cloudflare-access-remote.mjs',
  pagesDevSafePreviewVerifier: 'scripts/verify-cloudflare-pages-dev-safe-preview.mjs',
  readiness: 'data/cloud-deployment-readiness.json'
};

for (const [id, relPath] of Object.entries(files)) {
  check(fs.existsSync(path.join(repoRoot, relPath)), `${id}_exists`, `${relPath} must exist`);
}

const cloudEnv = readJson(files.cloudEnv);
const tenantExample = readJson(files.tenantExample);
const readiness = readJson(files.readiness);
const workflow = readText(files.workflow);
const localDeployScript = readText(files.localDeployScript);
const accessProvisioner = readText(files.accessProvisioner);
const actionsInfraVerifier = readText(files.actionsInfraVerifier);
const actionsDisabledVerifier = readText(files.actionsDisabledVerifier);
const remoteAccessVerifier = readText(files.remoteAccessVerifier);
const pagesDevSafePreviewVerifier = readText(files.pagesDevSafePreviewVerifier);
const wrangler = readText(files.wrangler);
const plan = readText(files.cloudPlan);

check(cloudEnv.schema_version === 'xlooop.cloudflare_deployment.v1', 'cloud_env_schema', 'Cloudflare deployment environment schema mismatch');
check(cloudEnv.canonical_product_name === 'Xlooop', 'product_name', 'product name must be Xlooop');
check(cloudEnv.stage === 'development_and_customer_feedback', 'stage', 'stage must be development_and_customer_feedback');

const environments = cloudEnv.environments || [];
check(environments.length === 2, 'env_count', 'exactly dev and test environments must be declared');
check(hasEnv(environments, 'dev', 'dev.xlooop.com'), 'dev_domain', 'dev must map to dev.xlooop.com');
check(hasEnv(environments, 'test', 'test.xlooop.com'), 'test_domain', 'test must map to test.xlooop.com');

const testEnv = environments.find((env) => env.environment === 'test') || {};
check(testEnv.operator_mode_default === 'watch_or_proposal_only', 'test_operator_default', 'test must default to watch/proposal-only');
check(testEnv.external_customer_ready === false, 'test_external_blocked_until_evidence', 'test must stay blocked until customer-safe evidence exists');
check(testEnv.requires_customer_safe_export_manifest === 'data/customer-safe-export-manifest.json', 'test_manifest_required', 'test must require customer-safe export manifest');
check(testEnv.pages_dev_safe_preview?.domain === 'xlooop-test.pages.dev', 'test_pages_dev_preview_domain', 'test must declare xlooop-test.pages.dev safe preview');
check(testEnv.pages_dev_safe_preview?.not_external_customer_feedback === true, 'test_pages_dev_not_external_feedback', 'pages.dev preview must not be external customer-feedback');
check(testEnv.pages_dev_safe_preview?.blocks_operator_mode === true, 'test_pages_dev_blocks_operator', 'pages.dev preview must block Operator mode');

check(cloudEnv.base64_or_code_access_policy?.not_security === true, 'access_code_not_security', 'routing code must not be treated as security');
check((cloudEnv.base64_or_code_access_policy?.required_real_controls || []).includes('cloudflare_access_identity'), 'cloudflare_access_identity_required', 'Cloudflare Access identity must be required');
check((cloudEnv.base64_or_code_access_policy?.required_real_controls || []).includes('tenant_entitlement'), 'tenant_entitlement_required', 'tenant entitlement must be required');

check(tenantExample.xlooop_entitlement?.enabled === true, 'tenant_xlooop_enabled', 'tenant example must enable Xlooop first-level access');
check(tenantExample.xlooop_entitlement?.default_action_mode === 'watch_or_proposal_only', 'tenant_watch_default', 'tenant example must default to watch/proposal-only');
check(tenantExample.xcp_second_level_entitlement?.enabled === false, 'tenant_xcp_disabled', 'XCP second-level entitlement must default disabled');
check(tenantExample.invitation_code?.purpose === 'routing_and_invitation_hint_only', 'tenant_code_routing_only', 'invitation code must be routing only');

check(/dist-cloudflare/.test(wrangler), 'wrangler_output', 'wrangler must deploy dist-cloudflare');
check(/CLOUDFLARE_API_TOKEN/.test(workflow), 'workflow_token_secret', 'workflow must use CLOUDFLARE_API_TOKEN secret');
check(/CLOUDFLARE_ACCOUNT_ID/.test(workflow), 'workflow_account_secret', 'workflow must use CLOUDFLARE_ACCOUNT_ID secret');
check(!/apiToken:\s*["'][A-Za-z0-9_\-]{20,}/.test(workflow), 'workflow_no_hardcoded_token', 'workflow must not hardcode Cloudflare token values');
check(/prepare-cloudflare-pages\.mjs/.test(workflow), 'workflow_prepare_step', 'workflow must prepare Cloudflare Pages bundle');
check(/verify-cloudflare-access-evidence\.mjs/.test(workflow), 'workflow_evidence_step', 'workflow must run the access evidence verifier');
check(/verify-cloudflare-access-remote\.mjs --env=test/.test(workflow), 'workflow_remote_access_step', 'custom-domain test deployment must remotely verify Cloudflare Access');
check(/\.github\/workflows/.test(actionsDisabledVerifier), 'actions_disabled_active_dir', 'Actions disabled verifier must inspect .github/workflows');
check(/deployment\/github-actions-disabled/.test(actionsDisabledVerifier), 'actions_disabled_templates', 'Actions disabled verifier must preserve disabled workflow templates');
check(/wrangler/.test(localDeployScript) && /pages/.test(localDeployScript) && /deploy/.test(localDeployScript), 'local_deploy_wrangler', 'local deploy fallback must deploy dist-cloudflare with Wrangler');
check(/verify-cloudflare-access-remote\.mjs/.test(localDeployScript), 'local_deploy_remote_access', 'feedback-mode local deploy must verify remote Access');
check(/access\/apps/.test(accessProvisioner), 'access_provisioner_apps_endpoint', 'Access provisioner must create or find Cloudflare Access applications');
check(/CLOUDFLARE_ACCESS_ALLOWED_EMAILS/.test(accessProvisioner), 'access_provisioner_named_testers', 'Access provisioner must require named tester emails');
check(/steps:\s*\[\]/.test(actionsInfraVerifier), 'actions_infra_empty_steps_detector', 'Actions infrastructure verifier must detect failed jobs with empty steps');
check(/\/access\/apps/.test(remoteAccessVerifier), 'remote_access_endpoint', 'remote Access verifier must inspect Cloudflare Access applications');
check(/xlooop-test\.pages\.dev/.test(pagesDevSafePreviewVerifier), 'pages_dev_preview_endpoint', 'pages.dev safe preview verifier must inspect xlooop-test.pages.dev posture');

check(readiness.canonical_public_domain === 'xlooop.com', 'readiness_canonical_domain', 'cloud readiness must keep xlooop.com canonical');
check(JSON.stringify(readiness).includes('test.xlooop.com'), 'readiness_test_domain', 'cloud readiness must mention test.xlooop.com');
check(/routing only|routing\/invitation|routing_and_invitation/.test(plan), 'plan_code_language', 'plan must state access code is routing only');

if (findings.length) {
  console.error('cloudflare-access-evidence: FAIL');
  for (const finding of findings) console.error(`  FAIL ${finding.id}: ${finding.message}`);
  process.exit(1);
}

console.log('cloudflare-access-evidence: PASS (Access + tenant entitlement + routing-code boundary declared)');

function readJson(relPath) {
  return JSON.parse(readText(relPath));
}

function readText(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function hasEnv(environments, name, domain) {
  return environments.some((env) => env.environment === name && env.domain === domain);
}

function check(ok, id, message) {
  if (!ok) findings.push({ id, message });
}
