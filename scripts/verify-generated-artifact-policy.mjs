#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = path.join(repoRoot, 'docs/engineering/generated-artifact-policy.json');
const pkgPath = path.join(repoRoot, 'package.json');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const failures = [];

function check(id, ok) {
  if (!ok) failures.push(id);
}

const classes = new Set((policy.rules || []).map((rule) => rule.class));
for (const klass of [
  'source-runtime',
  'verifier',
  'operator-runbook',
  'architecture-review',
  'generated-runtime-deliverable',
  'generated-read-model-snapshot',
  'generated-doc-index',
  'mutable-receipt',
  'customer-evidence',
]) {
  check(`class:${klass}`, classes.has(klass));
}

check('schema_version', policy.schema_version === 'xlooop.generated_artifact_policy.v1');
check('closeout_gate_unclassified_zero', policy.closeout_gate?.unclassified_dirty_files === 0);
check('closeout_gate_readonly_zero', policy.closeout_gate?.read_only_verifiers_tracked_changes === 0);
check('classifier_script_registered', pkg.scripts?.['classify:dirty-worktree'] === 'node scripts/classify-dirty-worktree.mjs --json');
check('dirty_verify_script_registered', pkg.scripts?.['verify:dirty-worktree-classification'] === 'node scripts/classify-dirty-worktree.mjs --verify');
check('policy_verify_script_registered', pkg.scripts?.['verify:generated-artifact-policy'] === 'node scripts/verify-generated-artifact-policy.mjs');

console.log(`verify-generated-artifact-policy · ${failures.length ? 'FAIL' : 'PASS'}`);
if (failures.length) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
