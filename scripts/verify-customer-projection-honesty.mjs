#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/customer-onboarding-read-model.json'), 'utf8'));
const failures = [];

if (model.customer?.status !== 'public_discovery') failures.push('APS must show public_discovery, not launched operations');
if (model.ecosystem_backbone?.github_status !== 'not_launched_authority_pending') failures.push('GitHub must not be claimed launched');
if (model.ecosystem_backbone?.first_workflow_status !== 'draft') failures.push('first workflow must remain draft until customer confirms');
if (model.public_discovery?.facts?.some((fact) => fact.status === 'confirmed' && fact.source !== 'operator_provided')) {
  failures.push('only operator-provided website input may be treated as confirmed at this stage');
}
if (!model.stop_conditions?.some((line) => line.includes('fake APS operations'))) failures.push('fake activity stop condition missing');

console.log(`verify-customer-projection-honesty · ${failures.length ? 'FAIL' : 'PASS'}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
