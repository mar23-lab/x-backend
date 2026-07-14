#!/usr/bin/env node
// Verifies customer/backend consumption uses effective redacted projections,
// not raw governance files or private graph surfaces.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const failures = [];
const checks = [];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function pass(id, details = {}) {
  checks.push({ id, status: 'PASS', ...details });
}

function fail(id, message, details = {}) {
  failures.push({ id, message, ...details });
  checks.push({ id, status: 'FAIL', message, ...details });
}

function requireMarkers(id, text, markers, details = {}) {
  const missing = markers.filter((marker) => !text.includes(marker));
  if (missing.length) fail(id, 'required markers missing', { missing, ...details });
  else pass(id, details);
}

const route = read('src/workers/routes/template-policy-registry.ts');
const mcp = read('src/workers/routes/mcp-gateway.ts');
const types = read('src/workers/dal/types/template-policy.ts');
const store = read('src/workers/dal/template-policy-store.ts');
const projection = readJson('docs/architecture/backend/GOVERNANCE_PROJECTION_COVERAGE.json');
const scripts = readJson('package.json').scripts || {};

requireMarkers('effective_template_route_customer_safe_markers', route, [
  'effective redacted templates',
  'raw_governance_files_exposed_to_customer_api: false',
  "governance: 'private_mbp_git'",
  "customer_operational_projection: 'xlooop_backend_postgres'",
  '/template-policy/effective-templates',
  '/template-policy/effective-snapshots',
  'membership_resolution',
  'clerk_org_membership_and_backend_rbac',
  'forbidden_surfaces',
]);

requireMarkers('template_registry_types_have_provenance_and_rollback', types, [
  'TemplateDefinition',
  'TemplateVersion',
  'TenantTemplateBinding',
  'UserTemplateOverlay',
  'PolicyDefinition',
  'PolicyDecision',
  'TemplateEvidenceRef',
  'TemplateAdminApproval',
  'EffectiveTemplateSnapshot',
  'source_ref',
  'content_sha256',
  'approval_ref',
  'rollback_version_id',
  'snapshot_hash',
  'source_version_ids',
  'evidence_ref_ids',
]);

requireMarkers('layered_inheritance_and_weakening_guards_present', store, [
  'TEMPLATE_POLICY_INHERITANCE_ORDER',
  'global platform default',
  'vertical pack',
  'company tenant binding',
  'workspace/project binding',
  'user overlay personalization',
  'TEMPLATE_POLICY_FORBIDDEN_OVERRIDE_KEYS',
  'tenant_isolation',
  'forbidden_surfaces',
]);

requireMarkers('mcp_consumes_scoped_surfaces_only', mcp, [
  'xlooop.whoami',
  'xlooop.get_task_packet',
  'xlooop.submit_evidence',
  'xlooop.report_tool_event',
  'xlooop.request_approval',
  'raw_graph',
  'full_tenant_memory',
  'private_graph_schema',
  'search_all_memory',
]);

const counts = projection.summary || {};
if (counts.raw_mbp_customer_api_exposure_allowed === false) pass('raw_mbp_customer_api_exposure_disabled');
else fail('raw_mbp_customer_api_exposure_not_disabled', 'raw MB-P exposure must be disabled');

const xcpTemplates = (projection.sources || []).filter((source) => source.classification === 'xcp_platform_template');
if (xcpTemplates.length === 4) pass('sanitized_xcp_template_catalog_count', { count: xcpTemplates.length });
else fail('sanitized_xcp_template_catalog_count_invalid', 'expected four xcp-platform sanitized templates', { count: xcpTemplates.length });

const backendProjection = (projection.sources || []).filter((source) => source.classification === 'backend_projection');
if (backendProjection.length >= 8) pass('backend_projection_sources_classified', { count: backendProjection.length });
else fail('backend_projection_sources_insufficient', 'expected at least eight backend projection sources', { count: backendProjection.length });

for (const script of [
  'verify:template-policy-registry',
  'verify:effective-template-resolution',
  'verify:no-raw-governance-template-exposure',
  'verify:backend-effective-template-consumption',
]) {
  if (scripts[script]) pass(`package_script_present:${script}`);
  else fail('package_script_missing', 'required backend consumption script missing', { script });
}

const report = {
  schema_id: 'xlooop.backend_effective_template_consumption.verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  checks,
  failures,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.status === 'PASS' ? 0 : 1);
