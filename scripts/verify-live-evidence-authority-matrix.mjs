#!/usr/bin/env node
// Central live-evidence authority matrix.
//
// This verifier consumes the three production-live authority lanes without
// replacing their specialist checks:
// 0. production database migration/RLS authority
// 1. public delete/export/legal-hold production receipt
// 2. external capability public-safe posture: either default-runtime evidence
//    for a reviewed promotion, or explicit non-default/canary-only authority
//    for public onboarding without default-enabling optional tools
// 3. API/MCP live lifecycle canary evidence
// 4. two-company 24-48h tenant-isolation evidence
//
// Normal mode passes only as an honest internal-validation posture. Strict mode
// fails closed until every live authority lane is configured and passing.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const strict =
  process.argv.includes('--strict-live-authority') ||
  process.env.XLOOOP_REQUIRE_PUBLIC_PRODUCTION_AUTHORITY === '1';
const checks = [];
const failures = [];
const warnings = [];

function run(id, command, args, options = {}) {
  const proc = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 12,
    env: process.env,
  });
  const parsed = parseLastJson(proc.stdout || '');
  const authority = options.authorityField ? parsed?.[options.authorityField] === true : proc.status === 0;
  const row = {
    id,
    status: proc.status === 0 ? 'PASS' : 'FAIL',
    exit_code: proc.status,
    authority,
    authority_field: options.authorityField || null,
    required_for_public_production: options.required === true,
    env_requirements: options.envRequirements || [],
    stdout_tail: (proc.stdout || '').slice(-1800),
    stderr_tail: (proc.stderr || '').slice(-1800),
    summary: parsed
      ? {
          schema_id: parsed.schema_id,
          status: parsed.status,
          public_self_serve_authority: parsed.public_self_serve_authority,
          production_db_live_authority: parsed.production_db_live_authority,
          external_capability_default_authority: parsed.external_capability_default_authority,
          api_mcp_live_canary_authority: parsed.api_mcp_live_canary_authority,
          internal_controlled_canary_authority: parsed.internal_controlled_canary_authority,
          internal_static_boundary_authority: parsed.internal_static_boundary_authority,
        }
      : null,
  };
  checks.push(row);
  if (!authority && options.required) {
    const warning = {
      id: `${id}_authority_absent`,
      message: options.message || 'Live authority evidence is absent.',
      env_requirements: row.env_requirements,
    };
    warnings.push(warning);
    if (strict) failures.push({ ...row, message: warning.message });
  }
  if (proc.status !== 0 && options.blockInternal) failures.push(row);
  return row;
}

run('public_self_serve_production_receipts', 'npm', ['run', '--silent', 'verify:public-self-serve-production-receipts'], {
  required: true,
  authorityField: 'public_self_serve_authority',
  envRequirements: ['XLOOOP_DELETE_EXPORT_RECEIPT_FILE -> production_live_receipt'],
  message: 'Public self-serve production requires a real delete/export/object-storage/legal-hold production_live_receipt.',
});

run('production_db_live_authority', 'npm', ['run', '--silent', 'verify:production-db-live-authority', '--', '--strict-live-db'], {
  required: true,
  authorityField: 'production_db_live_authority',
  envRequirements: [
    'DATABASE_URL',
    'XLOOOP_RLS_APP_DATABASE_URL',
  ],
  message: 'Production database authority requires prod migration parity and non-owner app-role RLS proof.',
});

run('external_capability_default_hard_stop', 'npm', ['run', '--silent', 'verify:external-capability-default-hard-stop'], {
  required: true,
  authorityField: 'internal_controlled_canary_authority',
  envRequirements: [
    'No external capability adopted_by_default=true in registry for public onboarding',
    'XLOOOP_REQUIRE_EXTERNAL_DEFAULTS=1 only for a separate default-promotion test',
    'XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE and strict runtime results before any default promotion',
  ],
  message: 'External capabilities must remain explicit non-default/canary-only for public onboarding unless strict default-promotion evidence is present.',
});

run('api_mcp_live_canary_hard_stop', 'npm', ['run', '--silent', 'verify:api-mcp-live-canary-hard-stop', '--', '--strict-live'], {
  required: true,
  authorityField: 'api_mcp_live_canary_authority',
  envRequirements: [
    'XLOOOP_REQUIRE_API_MCP_LIVE_CANARY=1',
    'XLOOOP_PARITY_PACKET_ID -> pkt-canary-*',
    'XLOOOP_CANARY_API_TOKEN or XLOOOP_CANARY_API_TOKEN_FILE',
    'XLOOOP_CANARY_LIFECYCLE_API_TOKEN or XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE',
  ],
  message: 'API/MCP live authority requires scoped canary packet and read/lifecycle canary credentials.',
});

run('two_company_live_pilot_evidence', 'npm', ['run', '--silent', 'verify:two-company-live-pilot-evidence'], {
  required: true,
  authorityField: 'two_company_live_pilot_authority',
  envRequirements: [
    'XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE -> xlooop.two_company_live_pilot_evidence.v1 JSON',
  ],
  message: 'Two-company customer onboarding requires 24-48h evidence for Andrey/APS plus a second customer tenant with zero leakage.',
});

const publicProductionAuthority = checks.every((row) => row.required_for_public_production && row.authority === true);
if (strict && !publicProductionAuthority) {
  failures.push({
    id: 'public_production_authority_blocked',
    status: 'FAIL',
    message: 'Public production authority is blocked until every live-evidence lane has authority=true.',
  });
}

const status = failures.length ? 'FAIL' : 'PASS';
const report = {
  schema_id: 'xlooop.live_evidence_authority_matrix.verifier.v1',
  status,
  strict_live_authority: strict,
  public_production_authority: publicProductionAuthority,
  internal_controlled_validation_authority: status === 'PASS' && publicProductionAuthority === false,
  authority_summary: {
    production_db_live_authority: authorityFor('production_db_live_authority'),
    public_self_serve_authority: authorityFor('public_self_serve_production_receipts'),
    external_capability_public_non_default_authority: authorityFor('external_capability_default_hard_stop'),
    api_mcp_live_canary_authority: authorityFor('api_mcp_live_canary_hard_stop'),
    two_company_live_pilot_authority: authorityFor('two_company_live_pilot_evidence'),
  },
  checks,
  failures,
  warnings,
  conclusion: publicProductionAuthority
    ? 'All public-production live evidence authority lanes are present.'
    : 'Internal controlled validation may continue, but public production authority remains blocked until every live-evidence lane passes.',
};

console.log(JSON.stringify(report, null, 2));
process.exit(status === 'PASS' ? 0 : 1);

function authorityFor(id) {
  return checks.find((row) => row.id === id)?.authority === true;
}

function parseLastJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to tail extraction for mixed human + JSON output.
    }
  }
  const start = text.lastIndexOf('\n{');
  const candidate = start >= 0 ? text.slice(start + 1) : text.slice(text.indexOf('{'));
  if (!candidate || !candidate.trim().startsWith('{')) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
