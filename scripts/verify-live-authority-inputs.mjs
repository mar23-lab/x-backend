#!/usr/bin/env node
// Preflight doctor for the live authority lanes used by the public-production
// hard-stop. This script does not grant authority; it verifies whether the
// required env vars/files are present and shaped enough to run the strict gates.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const checks = [];
const failures = [];
const warnings = [];

const requireExternalDefaults = process.env.XLOOOP_REQUIRE_EXTERNAL_DEFAULTS === '1';
const productionEvidenceFreshnessDays = 7;

function add(id, ok, details = {}, options = {}) {
  const status = ok ? 'PASS' : (options.warnOnly ? 'WARN' : 'FAIL');
  const row = { id, status, ...details };
  checks.push(row);
  if (!ok && !options.warnOnly) failures.push(row);
  if (!ok && options.warnOnly) warnings.push(row);
  return row;
}

function readJsonFile(envName) {
  const configured = process.env[envName] || '';
  add(`${envName.toLowerCase()}_configured`, Boolean(configured), {
    env: envName,
    configured: Boolean(configured),
  });
  if (!configured) return { configured: false, resolved: null, json: null };

  const resolved = path.resolve(configured);
  const exists = fs.existsSync(resolved);
  add(`${envName.toLowerCase()}_exists`, exists, { env: envName, file: resolved });
  if (!exists) return { configured: true, resolved, json: null };

  try {
    const json = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    add(`${envName.toLowerCase()}_json_valid`, true, { env: envName, file: resolved });
    return { configured: true, resolved, json };
  } catch (error) {
    add(`${envName.toLowerCase()}_json_valid`, false, { env: envName, file: resolved, error: error.message });
    return { configured: true, resolved, json: null };
  }
}

function checkTokenInput(id, envName, fileEnvName, defaultFile = '') {
  const envValue = process.env[envName] || '';
  const envConfigured = Boolean(envValue) && !looksLikePlaceholder(envValue);
  const filePath = process.env[fileEnvName] || defaultFile;
  const fileCheck = checkSecretFile(filePath);
  add(id, envConfigured || fileCheck.ok, {
    env: `${envName} or ${fileEnvName}`,
    token_source: envConfigured ? 'env' : (fileCheck.ok ? fileCheck.file : null),
    placeholder_rejected: Boolean(envValue) && looksLikePlaceholder(envValue),
    token_file_configured: Boolean(filePath),
    token_file_exists: fileCheck.exists,
    token_file_valid: fileCheck.ok,
  });
}

// Delete/export/legal-hold production receipt.
const deleteReceipt = readJsonFile('XLOOOP_DELETE_EXPORT_RECEIPT_FILE');
if (deleteReceipt.json) {
  const serialized = JSON.stringify(deleteReceipt.json).toLowerCase();
  const actionTime = Date.parse(deleteReceipt.json.action_executed_at || '');
  const generatedTime = Date.parse(deleteReceipt.json.generated_at || '');
  const generatedAgeDays = Number.isNaN(generatedTime)
    ? null
    : Math.round(((Date.now() - generatedTime) / 864e5) * 100) / 100;
  add('delete_export_receipt_is_production_live', deleteReceipt.json.evidence_class === 'production_live_receipt', {
    evidence_class: deleteReceipt.json.evidence_class || null,
  });
  add('delete_export_source_system_is_production_lifecycle', deleteReceipt.json.source_system === 'production_object_storage_lifecycle', {
    source_system: deleteReceipt.json.source_system || null,
  });
  add('delete_export_no_placeholder_markers', !/(synthetic|placeholder|example|redacted|changeme)/.test(serialized), {
    forbidden_markers: ['synthetic', 'placeholder', 'example', 'redacted', 'changeme'],
  });
  add('delete_export_dates_parse', !Number.isNaN(actionTime) && !Number.isNaN(generatedTime), {
    action_executed_at: deleteReceipt.json.action_executed_at || null,
    generated_at: deleteReceipt.json.generated_at || null,
  });
  add('delete_export_action_not_after_generated', Number.isNaN(actionTime) || Number.isNaN(generatedTime) || actionTime <= generatedTime, {
    action_executed_at: deleteReceipt.json.action_executed_at || null,
    generated_at: deleteReceipt.json.generated_at || null,
  });
  add('delete_export_receipt_fresh_enough', generatedAgeDays !== null && generatedAgeDays >= 0 && generatedAgeDays <= productionEvidenceFreshnessDays, {
    generated_age_days: generatedAgeDays,
    max_age_days: productionEvidenceFreshnessDays,
  });
  add('delete_export_verifier_command_uses_public_receipt_gate', /verify:public-self-serve-production-receipts/.test(String(deleteReceipt.json.verifier_command || '')), {
    verifier_command: deleteReceipt.json.verifier_command || null,
  });
  const receiptProofProblems = receiptProofProblemsFor(deleteReceipt.json.receipt_proofs);
  add('delete_export_external_receipt_proofs_present', receiptProofProblems.length === 0, {
    receipt_proof_problems: receiptProofProblems,
  });
  add('delete_export_negative_read_after_delete_true', deleteReceipt.json.negative_read_after_delete === true, {
    negative_read_after_delete: deleteReceipt.json.negative_read_after_delete,
  });
}

// Two-company live pilot evidence.
const pilotEvidence = readJsonFile('XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE');
if (pilotEvidence.json) {
  const serialized = JSON.stringify(pilotEvidence.json).toLowerCase();
  const companies = Array.isArray(pilotEvidence.json.companies) ? pilotEvidence.json.companies : [];
  const distinctTenants = new Set(companies.map((company) => company?.tenant_id).filter(Boolean));
  const sourceEvidenceProblems = companies.flatMap((company, index) => sourceEvidenceProblemsFor(company?.source_evidence, index));
  add('two_company_schema_valid', pilotEvidence.json.schema_id === 'xlooop.two_company_live_pilot_evidence.v1', {
    schema_id: pilotEvidence.json.schema_id || null,
  });
  add('two_company_evidence_is_external_live', pilotEvidence.json.evidence_class === 'external_live_pilot', {
    evidence_class: pilotEvidence.json.evidence_class || null,
  });
  add('two_company_duration_at_least_24h', Number(pilotEvidence.json.duration_hours) >= 24, {
    duration_hours: pilotEvidence.json.duration_hours,
  });
  add('two_company_distinct_tenants_present', companies.length >= 2 && distinctTenants.size >= 2, {
    company_count: companies.length,
    distinct_tenants: distinctTenants.size,
  });
  add('two_company_source_evidence_present', sourceEvidenceProblems.length === 0, {
    source_evidence_problems: sourceEvidenceProblems,
  });
  add('two_company_no_placeholder_markers', !/(placeholder|example|redacted|company_a|company_b)/.test(serialized), {
    forbidden_markers: ['placeholder', 'example', 'redacted', 'company_a', 'company_b'],
  });
}

// API/MCP live canary inputs.
const packetId = process.env.XLOOOP_PARITY_PACKET_ID || '';
add('api_mcp_canary_packet_configured', Boolean(packetId), {
  env: 'XLOOOP_PARITY_PACKET_ID',
  configured: Boolean(packetId),
});
add('api_mcp_canary_packet_prefixed', packetId.startsWith('pkt-canary-'), {
  env: 'XLOOOP_PARITY_PACKET_ID',
  canary_prefixed: packetId.startsWith('pkt-canary-'),
}, { warnOnly: !packetId });
checkTokenInput('api_mcp_read_token_configured', 'XLOOOP_CANARY_API_TOKEN', 'XLOOOP_CANARY_API_TOKEN_FILE', '/tmp/xlooop-canary-api-token.txt');
checkTokenInput('api_mcp_lifecycle_token_configured', 'XLOOOP_CANARY_LIFECYCLE_API_TOKEN', 'XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE', '/tmp/xlooop-canary-lifecycle-api-token.txt');

// Production DB/RLS inputs.
add('database_url_configured', Boolean(process.env.DATABASE_URL) && !looksLikePlaceholder(process.env.DATABASE_URL), {
  env: 'DATABASE_URL',
  configured: Boolean(process.env.DATABASE_URL),
  placeholder_rejected: Boolean(process.env.DATABASE_URL) && looksLikePlaceholder(process.env.DATABASE_URL),
});
add('rls_app_database_url_configured', Boolean(process.env.XLOOOP_RLS_APP_DATABASE_URL) && !looksLikePlaceholder(process.env.XLOOOP_RLS_APP_DATABASE_URL), {
  env: 'XLOOOP_RLS_APP_DATABASE_URL',
  configured: Boolean(process.env.XLOOOP_RLS_APP_DATABASE_URL),
  placeholder_rejected: Boolean(process.env.XLOOOP_RLS_APP_DATABASE_URL) && looksLikePlaceholder(process.env.XLOOOP_RLS_APP_DATABASE_URL),
});

// External capability promotion evidence.
const upstreamResults = readOptionalJsonFile('XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE', !requireExternalDefaults);
if (upstreamResults.json) {
  const capabilityResults = Array.isArray(upstreamResults.json.capability_results)
    ? upstreamResults.json.capability_results
    : [];
  add('external_capability_results_schema_present', Boolean(upstreamResults.json.schema_id), {
    schema_id: upstreamResults.json.schema_id || null,
  });
  add('external_capability_results_include_capabilities', capabilityResults.length > 0, {
    capability_result_count: capabilityResults.length,
  });
  add('external_capability_defaults_not_enabled_by_failed_results', capabilityResults.every((row) => row.default_adoption_allowed !== true), {
    default_adoption_allowed_count: capabilityResults.filter((row) => row.default_adoption_allowed === true).length,
  }, { warnOnly: true });
}

const laneReadiness = {
  public_self_serve_receipt_inputs_ready: checksFor([
    'xlooop_delete_export_receipt_file_configured',
    'xlooop_delete_export_receipt_file_exists',
    'xlooop_delete_export_receipt_file_json_valid',
    'delete_export_receipt_is_production_live',
    'delete_export_source_system_is_production_lifecycle',
    'delete_export_no_placeholder_markers',
    'delete_export_dates_parse',
    'delete_export_action_not_after_generated',
    'delete_export_receipt_fresh_enough',
    'delete_export_verifier_command_uses_public_receipt_gate',
    'delete_export_external_receipt_proofs_present',
    'delete_export_negative_read_after_delete_true',
  ]),
  two_company_live_inputs_ready: checksFor([
    'xlooop_two_company_pilot_evidence_file_configured',
    'xlooop_two_company_pilot_evidence_file_exists',
    'xlooop_two_company_pilot_evidence_file_json_valid',
    'two_company_schema_valid',
    'two_company_evidence_is_external_live',
    'two_company_duration_at_least_24h',
    'two_company_distinct_tenants_present',
    'two_company_source_evidence_present',
    'two_company_no_placeholder_markers',
  ]),
  api_mcp_live_inputs_ready: checksFor([
    'api_mcp_canary_packet_configured',
    'api_mcp_canary_packet_prefixed',
    'api_mcp_read_token_configured',
    'api_mcp_lifecycle_token_configured',
  ]),
  production_db_rls_inputs_ready: checksFor([
    'database_url_configured',
    'rls_app_database_url_configured',
  ]),
  external_default_inputs_ready: requireExternalDefaults ? checksFor([
    'xlooop_upstream_capability_results_file_configured',
    'xlooop_upstream_capability_results_file_exists',
    'xlooop_upstream_capability_results_file_json_valid',
    'external_capability_results_schema_present',
    'external_capability_results_include_capabilities',
  ]) : false,
};

const publicLaneIds = [
  'public_self_serve_receipt_inputs_ready',
  'two_company_live_inputs_ready',
  'api_mcp_live_inputs_ready',
  'production_db_rls_inputs_ready',
];
const requiredLaneReady = publicLaneIds.every((id) => laneReadiness[id] === true);
const externalDefaultInputsReady = requireExternalDefaults ? laneReadiness.external_default_inputs_ready === true : null;
const report = {
  schema_id: 'xlooop.live_authority_inputs.preflight.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  strict_public_inputs_ready: requiredLaneReady,
  external_defaults_required: requireExternalDefaults,
  external_default_inputs_ready: externalDefaultInputsReady,
  lane_readiness: laneReadiness,
  checks,
  failures,
  warnings,
  next_commands: requiredLaneReady
    ? [
        'npm run verify:public-production-readiness-hard-stop -- --strict-public',
      ]
    : [
        'configure the missing env/file inputs above',
        'npm run verify:live-authority-inputs',
        'npm run verify:public-production-readiness-hard-stop -- --strict-public',
      ],
};

console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);

function checksFor(ids) {
  return ids.every((id) => checks.find((row) => row.id === id)?.status === 'PASS');
}

function readOptionalJsonFile(envName, warnOnly) {
  const configured = process.env[envName] || '';
  add(`${envName.toLowerCase()}_configured`, Boolean(configured), {
    env: envName,
    configured: Boolean(configured),
  }, { warnOnly });
  if (!configured) return { configured: false, resolved: null, json: null };

  const resolved = path.resolve(configured);
  const exists = fs.existsSync(resolved);
  add(`${envName.toLowerCase()}_exists`, exists, { env: envName, file: resolved }, { warnOnly });
  if (!exists) return { configured: true, resolved, json: null };

  try {
    const json = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    add(`${envName.toLowerCase()}_json_valid`, true, { env: envName, file: resolved });
    return { configured: true, resolved, json };
  } catch (error) {
    add(`${envName.toLowerCase()}_json_valid`, false, { env: envName, file: resolved, error: error.message }, { warnOnly });
    return { configured: true, resolved, json: null };
  }
}

function looksLikePlaceholder(value = '') {
  return /\b(dummy|placeholder|example|redacted|changeme|postgresql:\/\/placeholder)\b/i.test(String(value));
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

function receiptProofProblemsFor(receiptProofs = {}) {
  const problems = [];
  for (const field of [
    'object_storage_receipt_id',
    'export_manifest_receipt_id',
    'delete_request_receipt_id',
    'legal_hold_receipt_id',
    'negative_read_receipt_id',
  ]) {
    if (typeof receiptProofs[field] !== 'string' || receiptProofs[field].trim() === '') {
      problems.push(`receipt_proofs.${field}`);
    }
  }
  return problems;
}

function checkSecretFile(filePath = '') {
  if (!filePath) return { file: null, exists: false, ok: false };
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return { file: resolved, exists: false, ok: false };
  try {
    const value = fs.readFileSync(resolved, 'utf8').trim();
    return { file: resolved, exists: true, ok: Boolean(value) && !looksLikePlaceholder(value) };
  } catch {
    return { file: resolved, exists: true, ok: false };
  }
}
