#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('wrangler.pilot-shadow.toml'), 'utf8');
const activeSource = source.split('\n').map((line) => line.replace(/#.*$/, '')).join('\n');
const errors = [];
const requireMatch = (pattern, message) => { if (!pattern.test(source)) errors.push(message); };
const migrationHeads = readdirSync(resolve('src/workers/db/migrations'))
  .map((name) => /^(\d{3})_.*\.sql$/.exec(name))
  .filter(Boolean)
  .map((match) => Number(match[1]));
const migrationHead = Math.max(...migrationHeads);
const configuredSchemaHead = Number(
  /^XLOOOP_SCHEMA_HEAD\s*=\s*"(\d+)"$/m.exec(source)?.[1],
);

requireMatch(/^name\s*=\s*"xlooop-api-pilot-shadow"$/m, 'worker name must be pilot-shadow');
requireMatch(/^workers_dev\s*=\s*true$/m, 'workers.dev preview must be enabled');
requireMatch(/^\s*\{\s*pattern\s*=\s*"api-test\.xlooop\.com",\s*custom_domain\s*=\s*true\s*\}\s*$/m, 'pilot API must use the isolated api-test.xlooop.com custom domain');
requireMatch(/^ENVIRONMENT\s*=\s*"pilot-shadow"$/m, 'environment must be pilot-shadow');
requireMatch(/^XLOOOP_AUTHORITY_MODE\s*=\s*"shadow"$/m, 'authority must remain shadow');
if (!Number.isInteger(migrationHead) || configuredSchemaHead !== migrationHead) {
  errors.push(`schema head must match current migration head ${migrationHead}`);
}
// Reuse the existing Access-protected test surface so x-ai-front remains the only product frontend.
requireMatch(/^ALLOWED_ORIGIN_PATTERN\s*=\s*"https:\/\/test\.xlooop\.com,https:\/\/\*\.xlooop-test\.pages\.dev"$/m, 'pilot frontend CORS must be scoped to test.xlooop.com plus xlooop-test Pages previews');
requireMatch(/^CLERK_AUTHORIZED_PARTIES\s*=\s*"https:\/\/test\.xlooop\.com"$/m, 'pilot Clerk authorized parties must be exactly test.xlooop.com');
requireMatch(/queue\s*=\s*"xlooop-tenant-projection-pilot-shadow"/m, 'isolated projection queue is required');
requireMatch(/^SINGLE_INTAKE_ENABLED\s*=\s*"true"$/m, 'single intake must be enabled');
requireMatch(/^ROLE_SKILL_CATALOG_ENABLED\s*=\s*"true"$/m, 'role/skill catalog must be enabled');
requireMatch(/^CONTEXT_PACKET_PERSISTENCE_ENABLED\s*=\s*"true"$/m, 'context packet persistence must be enabled');
requireMatch(/^CHAT_HISTORY_PERSISTENCE_REQUIRED\s*=\s*"true"$/m, 'customer chat history persistence must fail closed');
requireMatch(/^TENANT_PROJECTION_QUEUE_ENABLED\s*=\s*"true"$/m, 'tenant projection queue must be enabled');
requireMatch(/^CUSTOMER_API_TOKENS_ENABLED\s*=\s*"true"$/m, 'read-only customer connector tokens must be enabled for the commercial API-access proof');
requireMatch(/^CUSTOMER_OPERATIONAL_TOKENS_ENABLED\s*=\s*"false"$/m, 'operational customer connector tokens must remain explicitly disabled');
requireMatch(/^CUSTOMER_AUTO_PROVISION_ON_SESSION\s*=\s*"true"$/m, 'customer session auto-provision must be enabled');
requireMatch(/^CUSTOMER_AUTO_PROVISION_FROM_CLERK_ORG\s*=\s*"true"$/m, 'Clerk-org onboarding must be enabled');
requireMatch(/^CUSTOMER_INAPP_READINESS_GATE\s*=\s*"true"$/m, 'in-app readiness must gate first-session provisioning');
requireMatch(/^EXECUTOR_MODE\s*=\s*"disabled"$/m, 'executor must remain disabled');
requireMatch(/^ENTITLEMENT_ENFORCEMENT\s*=\s*"off"$/m, 'entitlement cutover must remain off');
requireMatch(/^PURGE_DELETED_ENABLED\s*=\s*"false"$/m, 'irreversible purge must remain disabled');

if (/\[\[routes\]\]|(?:^|[^-])api\.xlooop\.com|XLOOOP_AUTHORITY_MODE\s*=\s*"production"/.test(activeSource)) {
  errors.push('pilot-shadow config must not contain a production route or production authority');
}
const authorizedParties = /^CLERK_AUTHORIZED_PARTIES\s*=\s*"([^"]+)"$/m.exec(activeSource)?.[1] ?? '';
if (authorizedParties.includes('app.xlooop.com') || authorizedParties.includes('www.xlooop.com')) {
  errors.push('pilot Clerk authorized parties must not inherit production frontend origins');
}
if (/DIGEST_SWEEP_ENABLED\s*=\s*"true"|RECLASSIFY_CRON_ENABLED\s*=\s*"true"/.test(activeSource)) {
  errors.push('autonomous production loops must remain disabled');
}
if (/^(?:CUSTOMER_AUTO_PROVISION_APPROVER_USER_ID|MBP_OWNER_USER_ID)\s*=/m.test(activeSource)) {
  errors.push('onboarding approver identity must be a Worker secret, not committed pilot config');
}

if (errors.length) {
  console.error('FAIL pilot-shadow deployment boundary');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`PASS pilot-shadow deployment boundary: isolated worker, api-test custom domain, queue, shadow authority, schema ${migrationHead}, no production route`);
