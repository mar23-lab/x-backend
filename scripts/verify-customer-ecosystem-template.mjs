#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = path.join(repoRoot, 'templates/customer-ecosystem-template');
const required = [
  'README.md',
  'ONBOARDING.md',
  'identity/authority-and-consent.md',
  'identity/owner-and-roles.md',
  'sources/SOURCE_REGISTER.yml',
  'sources/DO_NOT_INGEST.yml',
  'domains/DOMAIN_REGISTRY.yml',
  'workflows/workflow-opportunity-radar.md',
  'goals/GOALS.md',
  'roadmap/ROADMAP.md',
  'todos/TODOS.md',
  'governance/PRIVACY_AND_CONSENT.md',
  'governance/ROLE_AND_INVITE_POLICY.md',
  'governance/AI_TOOL_READINESS.md',
  'activities/ACTIVITY_LOG.md',
  'retrospectives/ONBOARDING_LEARNINGS.md',
];
const failures = [];

for (const rel of required) {
  const full = path.join(templateRoot, rel);
  if (!fs.existsSync(full)) {
    failures.push(`template missing ${rel}`);
    continue;
  }
  const text = fs.readFileSync(full, 'utf8');
  if (/MB-P hard-rule|HR-[A-Z0-9-]+-\d+|engine weights?|prompt chain|architecture dependency map/i.test(text)) {
    failures.push(`${rel}: template leaks internal governance/IP detail`);
  }
}

for (const rel of ['sources/SOURCE_REGISTER.yml', 'sources/DO_NOT_INGEST.yml', 'identity/authority-and-consent.md']) {
  const text = read(rel);
  if (!/authority|consent|pending|blocked/i.test(text)) failures.push(`${rel}: must make authority/consent pending or blocked visible`);
}
if (!/3-5/.test(read('workflows/workflow-opportunity-radar.md'))) failures.push('workflow radar must require 3-5 opportunities');
if (!/Watch|proposal-only/i.test(read('governance/ROLE_AND_INVITE_POLICY.md'))) failures.push('role/invite policy must default to Watch or proposal-only');

emit('verify-customer-ecosystem-template', failures, { required_files: required.length });

function read(rel) {
  return fs.readFileSync(path.join(templateRoot, rel), 'utf8');
}

function emit(verifier, failures, metrics) {
  const status = failures.length ? 'FAIL' : 'PASS';
  console.log(`${verifier} · ${status} · files=${metrics.required_files}`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}
