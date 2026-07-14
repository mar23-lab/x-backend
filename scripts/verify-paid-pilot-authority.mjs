#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const contract = json('data/paid-pilot-authority-contract.json');
const migration = read('migrations/0003_paid_pilot_authority.sql');
const authority = read('functions/_lib/paid-pilot-authority.js');
const sessionRoute = read('functions/api/paid-pilot/session.js');
const manifest = json('data/xcp-shared-access-contract-consumption.json');
const sharedPack = json(manifest.contract_pack_path);

check('contract_schema', contract.schema_version === 'xlooop.paid_pilot_authority_contract.v1');
check('operator_gated_status', contract.pilot_status === 'operator_gated_go_with_restrictions_until_strict_cloud_receipt');
check('operator_gate_required', contract.operator_gate_required === true && contract.operator_decision_authority === 'Marat');
check('signature_required_contract', contract.signature_verification_required === true);
check('service_token_not_operator_authority', contract.service_token_headers_are_not_operator_authority === true);
check('xcp_default_disabled', contract.xcp_default_entitlement === 'disabled' && contract.xlooop_access_grants_xcp === false);
for (const table of contract.required_tables) {
  check(`migration_table:${table}`, migration.includes(`create table if not exists ${table}`));
}
for (const route of ['GET /api/paid-pilot/session', 'POST /api/actions/propose', 'POST /api/actions/execute']) {
  check(`contract_route:${route}`, contract.routes.includes(route));
}
for (const name of ['PaidPilotAuthorityContract', 'ActionPolicy', 'ExecutionReceipt', 'SourceWritebackReceipt']) {
  check(`shared_contract:${name}`, JSON.stringify(sharedPack).includes(name));
}
check('route_uses_paid_authority', sessionRoute.includes('requirePaidPilotPrincipal'));
check('requires_signature_env', authority.includes('CLOUDFLARE_ACCESS_VERIFY_SIGNATURE') && authority.includes('signature_verification_required'));
check('rejects_missing_jwt', authority.includes('missing_cf_access_jwt_assertion'));
check('no_trusted_service_header_operator_path', !/CF-Access-Client-Id[\s\S]{0,240}ok: true/.test(authority));
check('xcp_default_denied_runtime', authority.includes("app_id: 'xcp'") && authority.includes("status: 'disabled'"));
check('customer_default_watch_test', JSON.stringify(contract.default_customer_modes) === JSON.stringify(['watch', 'test']));

finish('verify-paid-pilot-authority');

function check(id, ok) {
  if (!ok) failures.push(id);
}

function finish(name) {
  if (failures.length) {
    console.error(`${name}: FAIL`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`${name}: PASS`);
}
