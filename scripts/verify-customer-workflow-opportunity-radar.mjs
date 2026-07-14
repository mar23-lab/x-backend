#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/customer-onboarding-read-model.json'), 'utf8'));
const radar = model.workflow_opportunity_radar;
const failures = [];

if (!radar) failures.push('workflow_opportunity_radar missing');
if (radar?.status !== 'public_hypothesis') failures.push('radar must start as public_hypothesis');
if (radar?.selector?.default_batch_size !== 5) failures.push('default batch size must be 5');
if (radar?.selector?.show_next_batch !== true) failures.push('show_next_batch must be enabled');
if (radar?.scoring?.validated_savings_required_before_claims !== true) failures.push('validated savings gate missing');
if (radar?.scoring?.unsupported_precise_savings_claims !== 0) failures.push('unsupported precise savings claims must be 0');

const opportunities = Array.isArray(radar?.opportunities) ? radar.opportunities : [];
if (opportunities.length < 5) failures.push('at least 5 workflow opportunities required');

for (const opportunity of opportunities) {
  const id = opportunity.id || '<missing id>';
  if (!Array.isArray(opportunity.public_basis) || opportunity.public_basis.length === 0) failures.push(`${id}: public_basis missing`);
  if (!Array.isArray(opportunity.internal_sources_required) || opportunity.internal_sources_required.length === 0) failures.push(`${id}: internal_sources_required missing`);
  if (!Array.isArray(opportunity.metrics_to_validate) || opportunity.metrics_to_validate.length === 0) failures.push(`${id}: metrics_to_validate missing`);
  if (!['high', 'medium', 'low'].includes(opportunity.confidence)) failures.push(`${id}: invalid confidence`);
  if (!['public_only', 'authority_pending', 'internal_sources_needed', 'source_validated'].includes(opportunity.source_posture)) failures.push(`${id}: invalid source_posture`);
  if (!opportunity.customer_confirmation_question) failures.push(`${id}: customer confirmation question missing`);
  const claimText = [
    opportunity.title,
    opportunity.customer_problem,
    opportunity.value_hypothesis,
  ].join(' ');
  if (/\$\d|\b\d+%\b|\b\d+\s*(hours?|hrs?|days?)\b/i.test(claimText)) {
    failures.push(`${id}: precise savings/ROI claim before validation`);
  }
}

emit('verify-customer-workflow-opportunity-radar', failures, {
  opportunities: opportunities.length,
  status: radar?.status || 'missing',
});

function emit(verifier, failures, metrics) {
  const status = failures.length ? 'FAIL' : 'PASS';
  const outRoot = process.env.XCP_VERIFY_READONLY === '0'
    ? path.join(repoRoot, 'docs', 'audits')
    : path.join('/private/tmp', 'xlooop-xcp-demo-readonly-audits');
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, `${verifier}.json`), `${JSON.stringify({ verifier, status, metrics, failures }, null, 2)}\n`);
  console.log(`${verifier} · ${status} · opportunities=${metrics.opportunities}`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}
