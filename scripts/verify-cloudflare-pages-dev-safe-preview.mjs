#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const environment = args.get('env') || 'test';
const findings = [];

const cloudConfig = readJson('deployment/cloudflare/environments.json');
const envConfig = (cloudConfig.environments || []).find((row) => row.environment === environment);
const manifestPath = envConfig?.pages_dev_safe_preview?.requires_customer_safe_export_manifest
  || envConfig?.requires_customer_safe_export_manifest
  || 'data/customer-safe-export-manifest.json';
const manifest = readJson(manifestPath);

check(environment === 'test', 'environment_test_only', 'pages.dev safe preview verifier is only valid for test');
check(Boolean(envConfig?.pages_dev_safe_preview), 'pages_dev_preview_declared', 'test environment must declare pages_dev_safe_preview');
check(envConfig?.pages_dev_safe_preview?.domain === 'xlooop-test.pages.dev', 'pages_dev_domain', 'pages.dev preview domain must be xlooop-test.pages.dev');
check(envConfig?.pages_dev_safe_preview?.allowed_before_custom_domain_access === true, 'pages_dev_allowed', 'pages.dev preview must explicitly be allowed before custom-domain Access');
check(envConfig?.pages_dev_safe_preview?.not_external_customer_feedback === true, 'not_external_feedback', 'pages.dev preview must not be classified as external customer-feedback');
check(envConfig?.pages_dev_safe_preview?.blocks_private_integrations === true, 'blocks_private_integrations', 'pages.dev preview must block private integrations');
check(envConfig?.pages_dev_safe_preview?.blocks_operator_mode === true, 'blocks_operator_mode', 'pages.dev preview must block Operator mode');

check(manifest.schema_version === 'xlooop.customer_safe_export_manifest.v1', 'manifest_schema', 'customer-safe export manifest schema mismatch');
check(manifest.environment === 'test', 'manifest_environment', 'manifest must target test');
check(manifest.status === 'approved', 'manifest_approved', 'manifest must be approved');
check(manifest.deployment_target === 'xlooop-test.pages.dev', 'manifest_target', 'manifest must target xlooop-test.pages.dev');
check(manifest.durable_target_access_status === 'deferred_dns_not_moved_to_cloudflare', 'custom_domain_deferred', 'custom-domain Access must be explicitly deferred');
check(manifest.external_private_data_allowed === false, 'no_external_private_data', 'external private data must be blocked');
check(manifest.operator_mode_allowed === false, 'no_operator_mode', 'Operator mode must be blocked');
check(manifest.private_integrations_allowed === false, 'no_private_integrations', 'private integrations must be blocked');
check(manifest.raw_customer_files_processed === false, 'no_raw_customer_files', 'raw customer files must not be processed');
check(manifest.watch_mode_only === true, 'watch_only', 'pages.dev test preview must be watch-only');

const blockedClaims = new Set(manifest.claim_posture?.blocked || []);
for (const claim of ['production SaaS', 'private source processing', 'operator mode', 'validated ROI', 'autonomous customer operations']) {
  check(blockedClaims.has(claim), `blocked_claim_${claim.replaceAll(' ', '_')}`, `${claim} must remain blocked`);
}

if (findings.length) {
  console.error('cloudflare-pages-dev-safe-preview: FAIL');
  for (const finding of findings) console.error(`  FAIL ${finding.id}: ${finding.message}`);
  process.exit(1);
}

console.log('cloudflare-pages-dev-safe-preview: PASS (xlooop-test.pages.dev safe/redacted watch-only preview)');

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function check(ok, id, message) {
  if (!ok) findings.push({ id, message });
}
