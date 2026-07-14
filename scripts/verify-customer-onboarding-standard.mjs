#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = readJson('data/customer-onboarding-read-model.json');
const failures = [];

if (model.schema_version !== 'xlooop.customer_onboarding_read_model.v1') failures.push('schema mismatch');
if (model.customer?.customer_id !== 'aps-access-property-services') failures.push('APS customer id missing');
if (model.authority?.status !== 'pending') failures.push('first APS projection must keep authority pending until confirmed');
if (model.consent?.private_integrations_allowed !== false) failures.push('private integrations must be blocked');
if (!Array.isArray(model.public_discovery?.facts) || model.public_discovery.facts.length < 4) failures.push('public discovery facts incomplete');
if (!Array.isArray(model.next_questions_for_customer) || model.next_questions_for_customer.length < 5) failures.push('confirmation questions incomplete');
if (!Array.isArray(model.stop_conditions) || model.stop_conditions.length < 4) failures.push('stop conditions incomplete');

emit('verify-customer-onboarding-standard', failures, {
  facts: model.public_discovery?.facts?.length || 0,
  onboarding_readiness: model.scorecard?.onboarding_readiness || 0,
});

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function emit(verifier, failures, metrics) {
  const status = failures.length ? 'FAIL' : 'PASS';
  const outRoot = process.env.XCP_VERIFY_READONLY === '0'
    ? path.join(repoRoot, 'docs', 'audits')
    : path.join('/private/tmp', 'xlooop-xcp-demo-readonly-audits');
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, `${verifier}.json`), `${JSON.stringify({ verifier, status, metrics, failures }, null, 2)}\n`);
  console.log(`${verifier} · ${status}`);
  if (failures.length) process.exit(1);
}
