#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
const failures = [];
const fail = (message) => failures.push(message);

const model = readJson('data/customer-health-value-read-model.json');

if (model.schema_version !== 'xlooop.customer_health_value_read_model.v1') {
  fail('schema_version must be xlooop.customer_health_value_read_model.v1');
}
if (model.review_mode !== 'authority_pending') fail('APS health baseline must remain authority_pending');
if (model.internal_knowledge_status !== 'not_provided') fail('APS internal knowledge status must be not_provided');
if (model.internal_knowledge_processed !== false) fail('internal_knowledge_processed must be false');
if (model.raw_dirty_files_processed !== false) fail('raw_dirty_files_processed must be false');
if (model.private_integrations_allowed !== false) fail('private integrations must remain blocked');
if (model.operator_mode_allowed !== false) fail('Operator mode must remain blocked');
if (model.github_remote_launch_allowed !== false) fail('GitHub remote launch must remain blocked');
if (model.team_invite_allowed !== false) fail('team invite must remain blocked');
if (model.score_cap > 70) fail('authority-pending APS score cap must not exceed 70');
if (model.capped_preliminary_score > model.score_cap) fail('capped score exceeds score cap');

const expectedScores = {
  onboarding_readiness: 62,
  ai_ready_ecosystem: 55,
  source_coverage: 58,
  privacy_safety: 82,
  team_invite_readiness: 42,
  workflow_opportunity_readiness: 86,
};
for (const [key, value] of Object.entries(expectedScores)) {
  if (model.preliminary_onboarding_scores?.[key] !== value) {
    fail(`preliminary_onboarding_scores.${key} must remain ${value}`);
  }
}

const dimensions = Array.isArray(model.dimensions) ? model.dimensions : [];
if (dimensions.length !== 10) fail('health model must have 10 weighted dimensions');
const weightSum = dimensions.reduce((sum, item) => sum + Number(item.weight || 0), 0);
if (weightSum !== 100) fail(`dimension weights must total 100, got ${weightSum}`);
for (const dimension of dimensions) {
  for (const field of ['dimension_id', 'weight', 'score_0_to_5', 'weighted_score', 'evidence_refs', 'source_posture', 'confidence', 'freshness_days', 'blocked_by']) {
    if (!(field in dimension)) fail(`dimension ${dimension.dimension_id || '<unknown>'} missing ${field}`);
  }
  if (!Array.isArray(dimension.evidence_refs) || dimension.evidence_refs.length === 0) {
    fail(`dimension ${dimension.dimension_id} must include evidence_refs`);
  }
}

const requiredDisclosures = [
  'APS has not provided approved internal/raw/dirty knowledge.',
  'Internal stance, value realised, workflow metrics, and ROI are not validated.',
  'Private integrations, GitHub remote launch, team invites, Operator mode, and exact ROI/savings claims remain blocked.',
];
for (const disclosure of requiredDisclosures) {
  if (!model.score_disclosures?.includes(disclosure)) fail(`missing disclosure: ${disclosure}`);
}
if (model.claim_hygiene?.unsupported_roi_claims !== 0) fail('unsupported ROI claims must be 0');

const templateText = fs.readFileSync(path.join(repoRoot, 'templates/customer-ecosystem-template/reports/CUSTOMER_HEALTH_VALUE_REALISATION_REPORT.md'), 'utf8');
for (const required of ['Executive verdict', 'Observed public professional focus', 'Value delivered since last review', 'Next review date']) {
  if (!templateText.includes(required)) fail(`report template missing ${required}`);
}

const forbiddenLeakPatterns = [
  /HR-[A-Z0-9-]+/,
  /private_mbp_path/i,
  /prompt_chain/i,
  /architecture_dependency_map/i,
  /scoring weights or formulas/i,
];
for (const pattern of forbiddenLeakPatterns) {
  if (pattern.test(JSON.stringify(model))) fail(`read model leaks forbidden pattern ${pattern}`);
}

console.log(`verify-customer-health-value-read-model · ${failures.length ? 'FAIL' : 'PASS'} · dimensions=${dimensions.length}`);
if (failures.length) {
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
