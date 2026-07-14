#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const failures = [];

const helper = read('functions/_lib/customer-feedback-authority.js');
const session = read('functions/api/session.js');
const proposals = read('functions/api/proposals.js');
const receipts = read('functions/api/receipts.js');
const telemetry = read('functions/api/telemetry/company.js');
const health = read('functions/api/health/customer-feedback.js');
const migration = read('migrations/0002_customer_feedback_authority.sql');
const contract = JSON.parse(read('data/server-tenant-policy-contract.json'));

check(helper.includes('validateAccessJwt'), 'access_jwt_validation_function', 'backend authority helper must validate Cloudflare Access JWT claims');
check(helper.includes('CLOUDFLARE_ACCESS_VERIFY_SIGNATURE'), 'access_jwt_signature_option', 'backend helper must expose signature verification option');
check(helper.includes('app_entitlements') && helper.includes('tenant_id') && helper.includes('permissions'), 'principal_shape', 'principal must include entitlements, tenant, and permissions');
check(helper.includes('xlooop_access_does_not_grant_xcp') || helper.includes("app_id: 'xcp'"), 'xcp_default_denied', 'XCP entitlement must be separate/default-denied');
check(helper.includes('proposal_only_customer_feedback'), 'proposal_only_policy', 'customer-feedback must default to proposal-only receipts');
check(helper.includes('company_aggregate_usage'), 'company_telemetry_scope', 'Marat owner/admin telemetry scope must be explicit');
check(helper.includes('tenant_raw_break_glass') === false, 'no_raw_break_glass_grant_in_runtime', 'runtime helper must not grant raw break-glass by default');
check(!helper.includes('(^|[+._-])marat'), 'no_name_pattern_owner_grant', 'owner/admin elevation must require configured owner email, not a broad local-part pattern');
check(session.includes('requirePrincipal') && session.includes('customer_feedback_policy'), 'session_route_policy', 'GET /api/session must expose governed session policy');
check(proposals.includes('insertProposal') && proposals.includes('proposal:create'), 'proposal_route_policy', 'POST /api/proposals must require proposal permission and persist proposal');
check(receipts.includes("requiredMode: 'operator'") && receipts.includes('receipt:create'), 'receipt_route_policy', 'POST /api/receipts must require Operator and receipt permission');
check(telemetry.includes('telemetry:company:read') && telemetry.includes('companyTelemetry'), 'company_telemetry_policy', 'company telemetry route must require aggregate telemetry scope');
check(health.includes('healthPayload'), 'health_route', 'customer-feedback health endpoint must exist');
for (const table of [
  'customer_feedback_tenant_memberships',
  'customer_feedback_app_entitlements',
  'customer_feedback_proposals',
  'customer_feedback_receipts',
  'customer_feedback_monitoring_events',
]) {
  check(migration.includes(`create table if not exists ${table}`), `migration:${table}`, `${table} migration table is required`);
}
check(contract.backend_authoritative === true, 'contract_backend_authoritative', 'server tenant policy contract must mark backend authority as present');
check(contract.status === 'backend_authority_present_customer_feedback_non_production', 'contract_status', 'contract must stay non-production while backend authority is present');
check(contract.paid_pilot_blocker.includes('redaction') && contract.paid_pilot_blocker.includes('monitoring'), 'contract_paid_pilot_blocker', 'paid/private pilot blocker must include redaction/monitoring controls');

if (failures.length) {
  console.error('customer-feedback-backend-authority: FAIL');
  for (const failure of failures) console.error(`- ${failure.id}: ${failure.message}`);
  process.exit(1);
}

console.log('customer-feedback-backend-authority: PASS (Cloudflare Access, D1 authority tables, proposal/receipt policy, and owner telemetry contracts present)');

function check(ok, id, message) {
  if (!ok) failures.push({ id, message });
}
