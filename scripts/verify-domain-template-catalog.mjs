#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = readJson('data/domain-template-catalog.json');
const templates = Array.isArray(catalog.templates) ? catalog.templates : [];
const required = ['investor_readiness', 'product_delivery', 'owner_governance', 'documentation_ops', 'frontend_reference', 'finance', 'accounting', 'construction_property', 'personal_goals'];
const failures = [];

if (catalog.schema_version !== 'xlooop.domain_template_catalog.v1') failures.push('schema mismatch');
for (const id of required) if (!templates.some((template) => template.template_id === id)) failures.push(`missing template ${id}`);
for (const template of templates) {
  for (const field of ['lane_set', 'workbench_set', 'data_source_expectations', 'action_contracts', 'storybook_requirements', 'setup_checklist']) {
    if (!Array.isArray(template[field]) || template[field].length === 0) failures.push(`${template.template_id} missing ${field}`);
  }
  if (!template.action_contracts?.includes('operator_proposal_receipt')) failures.push(`${template.template_id} missing operator proposal contract`);
}

emit({ verifier: 'verify-domain-template-catalog', status: failures.length ? 'FAIL' : 'PASS', metrics: catalog.metrics || {}, failures });
if (failures.length) process.exit(1);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}
function emit(report) {
  const readOnly = process.env.XCP_VERIFY_READONLY !== '0';
  const outRoot = readOnly ? path.join('/private/tmp', 'xlooop-xcp-demo-readonly-audits') : path.join(repoRoot, 'docs', 'audits');
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, 'domain-template-catalog.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.verifier} · ${report.status} · templates=${report.metrics.template_count || 0}`);
}
