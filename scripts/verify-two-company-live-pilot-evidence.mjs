#!/usr/bin/env node
// Strict two-company live pilot evidence verifier.
//
// This is the public-readiness evidence lane for proving tenant isolation with
// two real or synthetic customer companies. The older commercial-governance
// check verifies that the acceptance language exists; this verifier verifies
// the live evidence artifact and emits an authority boolean that composed gates
// can consume.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const strict =
  process.argv.includes('--strict-live') ||
  process.env.XLOOOP_REQUIRE_TWO_COMPANY_LIVE_PILOT === '1';
const evidenceFile = process.env.XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE || '';
const examplePathPattern = /(^|[/\\])[^/\\]*(?:schema\.)?example\.json$/i;
const checks = [];
const failures = [];
const warnings = [];

function check(id, ok, detail = {}, options = {}) {
  const row = { id, status: ok ? 'PASS' : (options.warnOnly ? 'WARN' : 'FAIL'), ...detail };
  checks.push(row);
  if (!ok && options.block) failures.push(row);
  if (!ok && options.warnOnly) warnings.push(row);
  return row;
}

check('evidence_file_configured', Boolean(evidenceFile), {
  env: 'XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE',
  evidence_file: evidenceFile || null,
}, { block: strict, warnOnly: !strict });

let evidence = null;
let authority = false;
if (evidenceFile) {
  const resolved = path.resolve(evidenceFile);
  check('evidence_file_exists', fs.existsSync(resolved), { evidence_file: resolved }, { block: strict, warnOnly: !strict });
  check('evidence_file_not_example', !examplePathPattern.test(resolved), {
    evidence_file: resolved,
    reason: 'Example/schema files are accepted for contract shape checks but cannot provide public live-pilot authority.',
  }, { block: strict, warnOnly: !strict });
  if (fs.existsSync(resolved)) {
    try {
      evidence = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      check('evidence_file_json', true, { evidence_file: resolved });
      verifyEvidence(evidence, resolved);
    } catch (error) {
      check('evidence_file_json', false, { evidence_file: resolved, error: error.message }, { block: true });
    }
  }
}

const status = failures.length ? 'FAIL' : 'PASS';
const report = {
  schema_id: 'xlooop.two_company_live_pilot_evidence.verifier.v1',
  status,
  strict_live: strict,
  two_company_live_pilot_authority: authority,
  evidence_file_configured: Boolean(evidenceFile),
  checks,
  failures,
  warnings,
  conclusion: authority
    ? 'Two-company live pilot evidence authority is present.'
    : 'Two-company live pilot evidence remains absent or non-authoritative; controlled validation may continue, but public onboarding cannot rely on this lane yet.',
};

console.log(JSON.stringify(report, null, 2));
process.exit(status === 'PASS' ? 0 : 1);

function verifyEvidence(e, evidencePath) {
  const missing = [];
  for (const field of [
    'schema_id',
    'evidence_class',
    'started_at',
    'ended_at',
    'duration_hours',
    'companies',
    'operator_checks',
    'andrey_checks',
    'hy_checks',
    'api_mcp_checks',
    'metrics',
    'audit_ids',
    'generated_at',
  ]) {
    if (e[field] === undefined || e[field] === '') missing.push(field);
  }
  check('required_fields_present', missing.length === 0, { missing }, { block: true });

  const duration = Number(e.duration_hours);
  check('schema_valid', e.schema_id === 'xlooop.two_company_live_pilot_evidence.v1', {
    schema_id: e.schema_id,
  }, { block: true });
  check('evidence_class_valid', ['internal_synthetic_canary', 'external_live_pilot'].includes(e.evidence_class), {
    evidence_class: e.evidence_class,
  }, { block: true });
  check('duration_at_least_24h', Number.isFinite(duration) && duration >= 24, {
    duration_hours: duration,
  }, { block: true });
  check('dates_parse', !Number.isNaN(Date.parse(e.started_at || '')) && !Number.isNaN(Date.parse(e.ended_at || '')) && !Number.isNaN(Date.parse(e.generated_at || '')), {
    started_at: e.started_at,
    ended_at: e.ended_at,
    generated_at: e.generated_at,
  }, { block: true });

  const companies = Array.isArray(e.companies) ? e.companies : [];
  const companyProblems = [];
  const sourceEvidenceProblems = [];
  const tenantIds = new Set();
  for (const [index, company] of companies.entries()) {
    if (!company.company_id) companyProblems.push(`companies[${index}].company_id`);
    if (!company.tenant_id) companyProblems.push(`companies[${index}].tenant_id`);
    if (company.tenant_id) tenantIds.add(company.tenant_id);
    if (!company.workspace_name) companyProblems.push(`companies[${index}].workspace_name`);
    if (!Number.isFinite(Number(company.employee_count)) || Number(company.employee_count) < 1) companyProblems.push(`companies[${index}].employee_count`);
    if (company.customer_only_employees !== true) companyProblems.push(`companies[${index}].customer_only_employees`);
    sourceEvidenceProblems.push(...sourceEvidenceProblemsFor(company.source_evidence, index));
  }
  check('two_distinct_companies_present', companies.length >= 2 && tenantIds.size >= 2 && companyProblems.length === 0, {
    company_count: companies.length,
    distinct_tenants: tenantIds.size,
    company_problems: companyProblems,
  }, { block: true });
  check('source_evidence_complete', sourceEvidenceProblems.length === 0, {
    source_evidence_problems: sourceEvidenceProblems,
    requirement: 'Each pilot company must prove connected/synced source state, workspace binding, at least one governed source event, and source audit ids.',
  }, { block: true });

  checkGroup('operator_checks', e.operator_checks, [
    'fresh_incognito_login',
    'andrey_only_workspace_visible',
    'hy_only_workspace_visible',
    'cross_tenant_search_zero',
    'diagnostics_hidden_for_customers',
  ]);
  checkGroup('andrey_checks', e.andrey_checks, [
    'fresh_login',
    'workspace_only_andrey',
    'project_only_asp_ap',
    'feedback_receipt_seen',
    'no_forbidden_strings',
  ]);
  checkGroup('hy_checks', e.hy_checks, [
    'fresh_login',
    'workspace_only_hy',
    'feedback_receipt_seen',
    'no_forbidden_strings',
  ]);
  checkGroup('api_mcp_checks', e.api_mcp_checks, [
    'andrey_whoami_tenant_correct',
    'hy_whoami_tenant_correct',
    'forbidden_surfaces_listed',
    'cross_tenant_packet_denied',
  ]);

  const metrics = e.metrics || {};
  const zeroMetrics = [
    'cross_tenant_leakage_count',
    'cross_tenant_search_hit_count',
    'unapproved_writes_count',
    'raw_graph_exposure_count',
    'forbidden_surface_exposure_count',
    'revocation_bypass_count',
    'auth_regression_count',
    'api_mcp_safety_regression_count',
  ];
  const metricProblems = zeroMetrics.filter((field) => metrics[field] !== 0);
  if (metrics.audit_coverage_pct !== 100) metricProblems.push('audit_coverage_pct');
  check('safety_metrics_zero', metricProblems.length === 0, {
    metric_problems: metricProblems,
  }, { block: true });

  check('audit_ids_present', Array.isArray(e.audit_ids) && e.audit_ids.length > 0, {
    audit_id_count: Array.isArray(e.audit_ids) ? e.audit_ids.length : 0,
  }, { block: true });

  authority =
    failures.length === 0 &&
    !examplePathPattern.test(evidencePath) &&
    e.evidence_class === 'external_live_pilot' &&
    duration >= 24 &&
    companies.length >= 2 &&
    tenantIds.size >= 2 &&
    sourceEvidenceProblems.length === 0;

  check('external_live_pilot_authority', authority, {
    evidence_file: evidencePath,
    evidence_class: e.evidence_class,
  }, { block: strict, warnOnly: !strict });
}

function sourceEvidenceProblemsFor(sourceEvidence = {}, companyIndex) {
  const problems = [];
  for (const field of [
    'provider',
    'source_connection_id',
    'workspace_id',
    'connection_status',
    'sync_status',
    'connected_at',
    'last_synced_at',
    'latest_event_at',
  ]) {
    if (typeof sourceEvidence[field] !== 'string' || sourceEvidence[field].trim() === '') {
      problems.push(`companies[${companyIndex}].source_evidence.${field}`);
    }
  }
  if (sourceEvidence.connection_status !== 'connected') {
    problems.push(`companies[${companyIndex}].source_evidence.connection_status`);
  }
  if (!['synced', 'completed'].includes(sourceEvidence.sync_status)) {
    problems.push(`companies[${companyIndex}].source_evidence.sync_status`);
  }
  if (!Number.isFinite(Number(sourceEvidence.emitted_event_count)) || Number(sourceEvidence.emitted_event_count) < 1) {
    problems.push(`companies[${companyIndex}].source_evidence.emitted_event_count`);
  }
  if (!Array.isArray(sourceEvidence.audit_ids) || sourceEvidence.audit_ids.length === 0) {
    problems.push(`companies[${companyIndex}].source_evidence.audit_ids`);
  }
  for (const dateField of ['connected_at', 'last_synced_at', 'latest_event_at']) {
    if (Number.isNaN(Date.parse(sourceEvidence[dateField] || ''))) {
      problems.push(`companies[${companyIndex}].source_evidence.${dateField}`);
    }
  }
  return [...new Set(problems)];
}

function checkGroup(groupName, group, requiredKeys) {
  const missing = [];
  for (const key of requiredKeys) {
    if (group?.[key] !== true) missing.push(key);
  }
  check(`${groupName}_complete`, missing.length === 0, { missing }, { block: true });
}
