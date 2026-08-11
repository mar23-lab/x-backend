#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const format = arg('format') || (process.argv.includes('--json') ? 'json' : 'text');

if (process.argv.includes('--self-test')) {
  const result = selfTest();
  print(result);
  process.exit(result.status === 'PASS' ? 0 : 1);
}

try {
  const inputPath = requiredPath('input');
  const outputPath = requiredPath('output');
  if (/example\.json$/i.test(outputPath)) throw new Error('Output cannot be an example/schema path.');
  if (fs.existsSync(outputPath) && !process.argv.includes('--replace')) {
    throw new Error('Output exists; pass --replace only after reviewing the prior receipt.');
  }

  const observed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const externalLive = process.argv.includes('--external-live');
  const evidence = buildEvidence(observed, externalLive, inputPath);
  validateElapsedRun(evidence, externalLive);
  writeVerified(evidence, outputPath, externalLive);
  print({
    status: 'PASS',
    evidence_file: outputPath,
    evidence_class: evidence.evidence_class,
    duration_hours: evidence.duration_hours,
    company_count: evidence.companies.length,
    source_input_sha256: evidence.builder.source_input_sha256,
  });
} catch (error) {
  print({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

function buildEvidence(observed, externalLive, inputPath) {
  const startedAt = iso(observed.started_at, 'started_at');
  const endedAt = iso(observed.ended_at, 'ended_at');
  const durationHours = round((Date.parse(endedAt) - Date.parse(startedAt)) / 3_600_000);
  if (externalLive && observed.evidence_class !== 'external_live_pilot') {
    throw new Error('External authority requires evidence_class=external_live_pilot in the reviewed observation input.');
  }
  return {
    schema_id: 'xlooop.two_company_live_pilot_evidence.v1',
    evidence_class: externalLive ? 'external_live_pilot' : 'internal_synthetic_canary',
    started_at: startedAt,
    ended_at: endedAt,
    duration_hours: durationHours,
    companies: array(observed.companies).map(company),
    operator_checks: group(observed.operator_checks),
    andrey_checks: group(observed.andrey_checks),
    hy_checks: group(observed.hy_checks),
    api_mcp_checks: group(observed.api_mcp_checks),
    metrics: metrics(observed.metrics),
    audit_ids: array(observed.audit_ids).filter(nonEmptyString),
    generated_at: new Date().toISOString(),
    builder: {
      id: 'create-two-company-live-pilot',
      source_input_sha256: sha256(fs.readFileSync(inputPath)),
      duration_derived_from_timestamps: true,
      raw_customer_data_copied: false,
    },
  };
}

function validateElapsedRun(evidence, externalLive) {
  if (Date.parse(evidence.ended_at) > Date.now()) throw new Error('ended_at cannot be in the future.');
  if (evidence.duration_hours < 24) throw new Error(`Observed duration is ${evidence.duration_hours}h; at least 24h must actually elapse.`);
  if (!externalLive && evidence.evidence_class !== 'internal_synthetic_canary') throw new Error('Internal evidence class mismatch.');
}

function writeVerified(evidence, outputPath, strictLive) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.pending-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const run = spawnSync(process.execPath, ['scripts/verify-two-company-live-pilot-evidence.mjs', ...(strictLive ? ['--strict-live'] : [])], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE: temporary },
  });
  if (run.status !== 0) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Evidence verifier rejected the candidate: ${String(run.stdout || run.stderr).slice(0, 2000)}`);
  }
  fs.renameSync(temporary, outputPath);
}

function company(value = {}) {
  return {
    company_id: text(value.company_id),
    tenant_id: text(value.tenant_id),
    workspace_name: text(value.workspace_name),
    employee_count: Number(value.employee_count),
    customer_only_employees: value.customer_only_employees === true,
    source_evidence: {
      provider: text(value.source_evidence?.provider),
      source_connection_id: text(value.source_evidence?.source_connection_id),
      workspace_id: text(value.source_evidence?.workspace_id),
      connection_status: text(value.source_evidence?.connection_status),
      sync_status: text(value.source_evidence?.sync_status),
      connected_at: text(value.source_evidence?.connected_at),
      last_synced_at: text(value.source_evidence?.last_synced_at),
      latest_event_at: text(value.source_evidence?.latest_event_at),
      emitted_event_count: Number(value.source_evidence?.emitted_event_count),
      audit_ids: array(value.source_evidence?.audit_ids).filter(nonEmptyString),
    },
  };
}

function metrics(value = {}) {
  const output = {};
  for (const key of [
    'cross_tenant_leakage_count', 'cross_tenant_search_hit_count', 'unapproved_writes_count',
    'raw_graph_exposure_count', 'forbidden_surface_exposure_count', 'revocation_bypass_count',
    'auth_regression_count', 'api_mcp_safety_regression_count', 'audit_coverage_pct',
  ]) output[key] = Number(value[key]);
  return output;
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xlooop-two-company-builder-'));
  const input = path.join(root, 'observations.json');
  const output = path.join(root, 'evidence.json');
  const ended = new Date(Date.now() - 3_600_000);
  const observed = fixture(new Date(ended.getTime() - 25 * 3_600_000), ended);
  fs.writeFileSync(input, JSON.stringify(observed));
  const checks = [];
  try {
    const evidence = buildEvidence(observed, true, input);
    validateElapsedRun(evidence, true);
    writeVerified(evidence, output, true);
    checks.push({ id: 'elapsed_external_run_finalizes', status: 'PASS' });
  } catch (error) {
    checks.push({ id: 'elapsed_external_run_finalizes', status: 'FAIL', error: error.message });
  }
  try {
    const premature = fixture(new Date(ended.getTime() - 10 * 3_600_000), ended);
    fs.writeFileSync(input, JSON.stringify(premature));
    validateElapsedRun(buildEvidence(premature, true, input), true);
    checks.push({ id: 'premature_run_refused', status: 'FAIL' });
  } catch {
    checks.push({ id: 'premature_run_refused', status: 'PASS' });
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { status: checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL', checks };
}

function fixture(started, ended) {
  const source = (suffix) => ({
    provider: 'governed-test-source', source_connection_id: `source-${suffix}`, workspace_id: `workspace-${suffix}`,
    connection_status: 'connected', sync_status: 'synced', connected_at: started.toISOString(),
    last_synced_at: ended.toISOString(), latest_event_at: ended.toISOString(), emitted_event_count: 2,
    audit_ids: [`audit-source-${suffix}`],
  });
  return {
    evidence_class: 'external_live_pilot', started_at: started.toISOString(), ended_at: ended.toISOString(),
    companies: [
      { company_id: 'company-a', tenant_id: 'tenant-a', workspace_name: 'A', employee_count: 1, customer_only_employees: true, source_evidence: source('a') },
      { company_id: 'company-b', tenant_id: 'tenant-b', workspace_name: 'B', employee_count: 1, customer_only_employees: true, source_evidence: source('b') },
    ],
    operator_checks: { fresh_incognito_login: true, andrey_only_workspace_visible: true, hy_only_workspace_visible: true, cross_tenant_search_zero: true, diagnostics_hidden_for_customers: true },
    andrey_checks: { fresh_login: true, workspace_only_andrey: true, project_only_asp_ap: true, feedback_receipt_seen: true, no_forbidden_strings: true },
    hy_checks: { fresh_login: true, workspace_only_hy: true, feedback_receipt_seen: true, no_forbidden_strings: true },
    api_mcp_checks: { andrey_whoami_tenant_correct: true, hy_whoami_tenant_correct: true, forbidden_surfaces_listed: true, cross_tenant_packet_denied: true },
    metrics: { cross_tenant_leakage_count: 0, cross_tenant_search_hit_count: 0, unapproved_writes_count: 0, raw_graph_exposure_count: 0, forbidden_surface_exposure_count: 0, revocation_bypass_count: 0, auth_regression_count: 0, api_mcp_safety_regression_count: 0, audit_coverage_pct: 100 },
    audit_ids: ['audit-a', 'audit-b'],
  };
}

function requiredPath(name) {
  const value = arg(name);
  if (!value) throw new Error(`--${name}=PATH is required.`);
  const resolved = path.resolve(value);
  if (name === 'input' && !fs.existsSync(resolved)) throw new Error(`Input does not exist: ${resolved}`);
  return resolved;
}

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
}
function iso(value, name) {
  const parsed = Date.parse(value || '');
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}
function group(value) { return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, item === true])); }
function array(value) { return Array.isArray(value) ? value : []; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function nonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function round(value) { return Math.round(value * 100) / 100; }
function print(value) { console.log(format === 'json' ? JSON.stringify(value, null, 2) : `${value.status}: ${JSON.stringify(value)}`); }
