#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const failures = [];

const helper = read('functions/_lib/customer-feedback-authority.js');
const feedback = read('functions/api/feedback.js');
const health = read('functions/api/health/customer-feedback.js');
const migration = read('migrations/0002_customer_feedback_authority.sql');
const runbook = read('docs/deployment/CUSTOMER_FEEDBACK_INCIDENT_SLA_RUNBOOK.md');

check(helper.includes('FORBIDDEN_PATTERNS'), 'redaction_patterns', 'customer-safe API helper must define forbidden redaction patterns');
check(helper.includes('assertCustomerSafe') && helper.includes('customerSafeJson'), 'customer_safe_json', 'customer-facing APIs must scan responses before returning JSON');
check(helper.includes('recordMonitoringEvent'), 'monitoring_writer', 'monitoring event writer must exist');
for (const event of ['auth_denied', 'tenant_denied', 'redaction_blocked', 'proposal_created', 'receipt_created', 'freshness_stale', 'api_error']) {
  check(runbook.includes(event) || helper.includes(event), `monitoring_event:${event}`, `${event} monitoring event must be documented or emitted`);
}
check(feedback.includes('forbiddenContent') && feedback.includes('Forbidden private/internal content'), 'feedback_payload_scan', 'feedback payloads must reject forbidden private/internal content');
check(health.includes('redaction_scan') && health.includes('freshness_status'), 'health_redaction_freshness', 'health endpoint must report redaction and freshness posture');
check(migration.includes('customer_feedback_monitoring_events'), 'monitoring_migration', 'monitoring events table migration is required');
check(runbook.includes('No production SaaS claim') && runbook.includes('leakage stop condition'), 'claim_sla_runbook', 'incident/SLA runbook must block unsupported production/private claims');

if (failures.length) {
  console.error('customer-feedback-redaction-monitoring: FAIL');
  for (const failure of failures) console.error(`- ${failure.id}: ${failure.message}`);
  process.exit(1);
}

console.log('customer-feedback-redaction-monitoring: PASS (redaction scan, monitoring events, health endpoint, incident/SLA runbook)');

function check(ok, id, message) {
  if (!ok) failures.push({ id, message });
}
