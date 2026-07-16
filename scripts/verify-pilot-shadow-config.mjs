#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('wrangler.pilot-shadow.toml'), 'utf8');
const activeSource = source.split('\n').map((line) => line.replace(/#.*$/, '')).join('\n');
const errors = [];
const requireMatch = (pattern, message) => { if (!pattern.test(source)) errors.push(message); };

requireMatch(/^name\s*=\s*"xlooop-api-pilot-shadow"$/m, 'worker name must be pilot-shadow');
requireMatch(/^workers_dev\s*=\s*true$/m, 'workers.dev preview must be enabled');
requireMatch(/^ENVIRONMENT\s*=\s*"pilot-shadow"$/m, 'environment must be pilot-shadow');
requireMatch(/^XLOOOP_AUTHORITY_MODE\s*=\s*"shadow"$/m, 'authority must remain shadow');
requireMatch(/^XLOOOP_SCHEMA_HEAD\s*=\s*"79"$/m, 'schema head must match the candidate migration head');
requireMatch(/queue\s*=\s*"xlooop-tenant-projection-pilot-shadow"/m, 'isolated projection queue is required');
requireMatch(/^SINGLE_INTAKE_ENABLED\s*=\s*"true"$/m, 'single intake must be enabled');
requireMatch(/^ROLE_SKILL_CATALOG_ENABLED\s*=\s*"true"$/m, 'role/skill catalog must be enabled');
requireMatch(/^CONTEXT_PACKET_PERSISTENCE_ENABLED\s*=\s*"true"$/m, 'context packet persistence must be enabled');
requireMatch(/^CHAT_HISTORY_PERSISTENCE_REQUIRED\s*=\s*"true"$/m, 'customer chat history persistence must fail closed');
requireMatch(/^TENANT_PROJECTION_QUEUE_ENABLED\s*=\s*"true"$/m, 'tenant projection queue must be enabled');
requireMatch(/^EXECUTOR_MODE\s*=\s*"disabled"$/m, 'executor must remain disabled');
requireMatch(/^ENTITLEMENT_ENFORCEMENT\s*=\s*"off"$/m, 'entitlement cutover must remain off');
requireMatch(/^PURGE_DELETED_ENABLED\s*=\s*"false"$/m, 'irreversible purge must remain disabled');

if (/\[\[routes\]\]|api\.xlooop\.com|XLOOOP_AUTHORITY_MODE\s*=\s*"production"/.test(activeSource)) {
  errors.push('pilot-shadow config must not contain a production route or production authority');
}
if (/DIGEST_SWEEP_ENABLED\s*=\s*"true"|RECLASSIFY_CRON_ENABLED\s*=\s*"true"/.test(activeSource)) {
  errors.push('autonomous production loops must remain disabled');
}

if (errors.length) {
  console.error('FAIL pilot-shadow deployment boundary');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('PASS pilot-shadow deployment boundary: isolated worker, queue, shadow authority, no production route');
