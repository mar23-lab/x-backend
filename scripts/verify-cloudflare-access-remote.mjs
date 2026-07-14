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
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployment/cloudflare/environments.json'), 'utf8'));
const envConfig = (config.environments || []).find((row) => row.environment === environment);
const domain = args.get('domain') || resolveAccessDomain(environment, envConfig);

if (!domain) fail(`No domain found for environment '${environment}'`);

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token) fail('CLOUDFLARE_API_TOKEN is required for remote Access verification');
if (!accountId) fail('CLOUDFLARE_ACCOUNT_ID is required for remote Access verification');

const apps = await listAccessApps();
const app = apps.find((candidate) => appCoversDomain(candidate, domain));

if (!app) {
  fail(`No Cloudflare Access application protects ${domain}. Create a Zero Trust Access self-hosted app before customer-feedback use.`);
}

if (app.type && app.type !== 'self_hosted') {
  fail(`Cloudflare Access app for ${domain} must be self_hosted; found ${app.type}`);
}

const policies = await listPolicies(app);
const serviceAuthPolicies = policies.filter((policy) => isServiceAuthPolicy(policy));
const allowPolicies = policies.filter((policy) => policy.decision === 'allow');
if (!serviceAuthPolicies.length) {
  fail(`Cloudflare Access app for ${domain} has no Service Auth policy. Service tokens require policy action 'Service Auth'; an Allow policy alone redirects to the identity provider.`);
}

console.log(JSON.stringify({
  status: 'PASS',
  schema_version: 'xlooop.cloudflare_access_remote_verification.v1',
  environment,
  domain,
  durable_domain: envConfig?.domain || null,
  domain_selection_reason: domain === envConfig?.domain ? 'durable_environment_domain' : 'pages_dev_safe_preview_while_custom_domain_dns_deferred',
  access_application_id: app.id,
  access_application_name: app.name,
  access_application_type: app.type || 'unknown',
  service_auth_policy_count: serviceAuthPolicies.length,
  allow_policy_count: allowPolicies.length,
  checked_at: new Date().toISOString()
}, null, 2));

function resolveAccessDomain(environmentName, environmentConfig) {
  if (!environmentConfig) return null;
  if (environmentName === 'test') {
    const manifestPath = environmentConfig.pages_dev_safe_preview?.requires_customer_safe_export_manifest
      || environmentConfig.requires_customer_safe_export_manifest
      || 'data/customer-safe-export-manifest.json';
    const manifest = readJsonIfExists(manifestPath);
    if (
      manifest?.durable_target_access_status === 'deferred_dns_not_moved_to_cloudflare'
      && environmentConfig.pages_dev_safe_preview?.domain
    ) {
      return environmentConfig.pages_dev_safe_preview.domain;
    }
  }
  return environmentConfig.domain;
}

function readJsonIfExists(relPath) {
  try {
    const abs = path.join(repoRoot, relPath);
    if (!fs.existsSync(abs)) return null;
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function listAccessApps() {
  const results = [];
  for (let page = 1; page <= 20; page += 1) {
    const payload = await cfFetch(`/accounts/${accountId}/access/apps?per_page=100&page=${page}`);
    results.push(...(payload.result || []));
    const info = payload.result_info || {};
    if (!info.total_pages || page >= info.total_pages) break;
  }
  return results;
}

async function listPolicies(app) {
  if (Array.isArray(app.policies) && app.policies.length) return app.policies;
  if (!app.id) return [];
  const payload = await cfFetch(`/accounts/${accountId}/access/apps/${app.id}/policies`);
  return payload.result || [];
}

function appCoversDomain(app, targetDomain) {
  const domains = [
    app.domain,
    ...(Array.isArray(app.self_hosted_domains) ? app.self_hosted_domains : [])
  ].filter(Boolean);
  return domains.includes(targetDomain);
}

function isServiceAuthPolicy(policy) {
  // Cloudflare's dashboard labels this as "Service Auth", while the API can
  // expose the policy decision as `non_identity`.
  return policy.decision === 'service_auth' || policy.decision === 'non_identity';
}

async function cfFetch(pathname) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.map((error) => error.message).join('; ') || response.statusText;
    fail(`Cloudflare API ${pathname} failed: ${message}`);
  }
  return payload;
}

function fail(message) {
  console.error(`cloudflare-access-remote: FAIL - ${message}`);
  process.exit(1);
}
