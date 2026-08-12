#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selfTest = process.argv.includes('--self-test');

function validate(paths) {
  const failures = [];
  const forbidden = paths.filter((path) => /(?:^|\/)(?:\.terraform)(?:\/|$)|\.tfstate(?:\.|$)|\.tfplan$|\.auto\.tfvars$/.test(path));
  if (forbidden.length) failures.push(`forbidden Terraform outputs tracked: ${forbidden.join(', ')}`);
  for (const required of [
    'infrastructure/terraform/bootstrap/main.tf',
    'infrastructure/terraform/bootstrap/rbac.tf',
    'infrastructure/terraform/workloads/main.tf',
    'infrastructure/terraform/workloads/rbac.tf',
  ]) if (!paths.includes(required) && !selfTest) failures.push(`missing Terraform source: ${required}`);
  return failures;
}

if (selfTest) {
  const failures = validate(['infrastructure/terraform/bootstrap/main.tf', 'infrastructure/terraform/bootstrap/terraform.tfstate']);
  if (failures.some((failure) => failure.startsWith('forbidden Terraform outputs tracked:'))) {
    console.log('SELF-TEST PASS Terraform source authority - tracked state breach rejected');
    process.exit(0);
  }
  console.error('SELF-TEST FAIL Terraform source authority');
  process.exit(1);
}

if (!existsSync(resolve(ROOT, 'infrastructure/terraform/README.md'))) {
  console.error('FAIL Terraform source authority - authority README missing');
  process.exit(2);
}
const paths = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const failures = validate(paths);
if (failures.length) {
  console.error(`FAIL Terraform source authority (${failures.length})`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('PASS Terraform source authority - declarative source is owned by x-backend; state and plans are excluded.');
