#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const activeWorkflowDir = path.join(repoRoot, '.github', 'workflows');
const disabledWorkflowDir = path.join(repoRoot, 'deployment', 'github-actions-disabled');
const findings = [];

const activeWorkflows = listYamlFiles(activeWorkflowDir);
const disabledTemplates = listYamlFiles(disabledWorkflowDir);

check(activeWorkflows.length === 0, 'no_active_github_actions_workflows', 'No active .github/workflows/*.yml files are allowed while GitHub Actions is unpaid/unavailable');
for (const expected of ['cloudflare-feedback-d1.yml', 'cloudflare-pages.yml', 'smoke.yml', 'verify.yml']) {
  check(disabledTemplates.includes(expected), `disabled_template_${expected}`, `Disabled workflow template must be preserved at deployment/github-actions-disabled/${expected}`);
}

if (findings.length) {
  console.error('github-actions-disabled: FAIL');
  for (const finding of findings) console.error(`  FAIL ${finding.id}: ${finding.message}`);
  process.exit(1);
}

console.log('github-actions-disabled: PASS (no active GitHub Actions workflows; templates preserved for future paid runner restoration)');

function listYamlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /\.(ya?ml)$/i.test(name))
    .sort();
}

function check(ok, id, message) {
  if (!ok) findings.push({ id, message });
}
