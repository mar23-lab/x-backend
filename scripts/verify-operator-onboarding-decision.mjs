#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/operator-onboarding-decision.json'), 'utf8'));
const template = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/operator-onboarding-decision.example.json'), 'utf8'));
const failures = [];

check(state.schema_version === 'xlooop.operator_onboarding_decision_state.v1', 'decision_state_schema');
check(state.operator_id === 'Marat', 'operator_authority_marat');
check(template.schema_version === 'xlooop.operator_onboarding_decision_template.v1', 'decision_template_schema');
check(template.status === 'template_only_not_authority', 'decision_template_not_authority');
check(template.decision?.operator_id === 'Marat', 'decision_template_operator');
check(template.decision?.xcp_access?.granted === false, 'decision_template_xcp_not_granted');
check(Array.isArray(template.forbidden_defaults) && template.forbidden_defaults.includes('XCP access from Xlooop access'), 'decision_template_forbids_xlooop_to_xcp');

if (state.status === 'not_recorded') {
  check(state.active_decision === null, 'no_active_decision_when_not_recorded');
} else if (state.status === 'recorded') {
  const decision = state.active_decision || {};
  check(decision.schema_version === 'xcp.operator_onboarding_decision.v1', 'active_decision_schema');
  check(decision.operator_id === 'Marat', 'active_decision_operator');
  check(Array.isArray(decision.allowed_apps) && decision.allowed_apps.length > 0, 'active_decision_apps');
  check(Array.isArray(decision.allowed_modes) && decision.allowed_modes.includes('operator'), 'active_decision_modes_operator');
  check(Array.isArray(decision.evidence_refs) && decision.evidence_refs.length > 0, 'active_decision_evidence_refs');
  if ((decision.allowed_apps || []).includes('xcp')) {
    check(decision.xcp_access?.granted === true && (decision.evidence_refs || []).some((ref) => String(ref).includes('xcp')), 'xcp_requires_explicit_evidence');
  }
} else {
  failures.push(`unexpected_decision_status:${state.status}`);
}

if (failures.length) {
  console.error('operator-onboarding-decision: FAIL');
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}

console.log(`operator-onboarding-decision: PASS (${state.status})`);

function check(ok, id) {
  if (!ok) failures.push(id);
}
