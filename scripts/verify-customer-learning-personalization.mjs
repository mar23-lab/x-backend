#!/usr/bin/env node
// Verifies customer/user learning personalization is backend-scoped,
// private-by-default, promotion-gated, and not a governance weakening channel.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const checks = [];
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function pass(id, details = {}) {
  checks.push({ id, status: 'PASS', ...details });
}

function fail(id, message, details = {}) {
  failures.push({ id, message, ...details });
  checks.push({ id, status: 'FAIL', message, ...details });
}

function requireFile(rel) {
  if (!fs.existsSync(path.join(repoRoot, rel))) {
    fail(`file_present:${rel}`, 'required file missing', { file: rel });
    return '';
  }
  pass(`file_present:${rel}`, { file: rel });
  return read(rel);
}

function includesAll(id, source, needles) {
  const missing = needles.filter((needle) => !source.includes(needle));
  if (missing.length) fail(id, 'required markers missing', { missing });
  else pass(id);
}

const migration = requireFile('src/workers/db/migrations/036_customer_learning_personalization.sql');
const route = requireFile('src/workers/routes/template-policy-registry.ts');
const mcpGateway = requireFile('src/workers/routes/mcp-gateway.ts');
const store = requireFile('src/workers/dal/template-policy-store.ts');
const types = requireFile('src/workers/dal/types/template-policy.ts');
const tests = requireFile('src/workers/__tests__/template-policy-registry-route.test.ts');
const doc = requireFile('docs/architecture/backend/CUSTOMER_LEARNING_PERSONALIZATION_ARCHITECTURE.md');
const pkg = JSON.parse(requireFile('package.json') || '{}');

includesAll('migration_learning_tables_present', migration, [
  'user_personalization_profiles',
  'user_learning_signals',
  'tenant_learning_profiles',
  'tenant_learning_promotions',
  'ENABLE ROW LEVEL SECURITY',
  'customer/user learning personalization registry',
]);

includesAll('route_learning_surfaces_present', route, [
  '/template-policy/personalization/effective-profile',
  '/template-policy/personalization/signals',
  '/template-policy/personalization/promotions',
  'private_by_default_with_explicit_company_promotion',
  'service-principal tokens cannot write personal learning signals',
  'learning payload cannot contain governance/security override keys',
  'tenant learning promotion requires admin/operator role',
]);

includesAll('mcp_customer_gateway_contract_present', mcpGateway, [
  'CUSTOMER_MCP_CONNECTOR_NAMESPACE',
  'xlooop-customer-gateway',
  'xlooop.get_effective_templates',
  'xlooop.get_effective_profile',
  'xlooop.submit_learning_signal',
  'mb_p_governance_internals',
  'graph_authority',
]);

includesAll('store_learning_guards_present', store, [
  'getEffectivePersonalizationProfileRow',
  'createUserLearningSignalRow',
  'createTenantLearningPromotionRow',
  'findForbiddenOverridePath',
  'tenant-share learning signals require consent_ref',
  'forbidden governance override key',
]);

includesAll('types_learning_contract_present', types, [
  'EffectivePersonalizationProfile',
  'UserLearningSignal',
  'TenantLearningPromotion',
  'private_by_default_with_explicit_company_promotion',
]);

includesAll('tests_learning_contract_present', tests, [
  'returns company + private user profile',
  'records private user learning and rejects service principals',
  'rejects forbidden governance override payloads',
  'requires owner/operator approval path',
]);

includesAll('docs_learning_architecture_present', doc, [
  'Company profile',
  'Role profile',
  'User private profile',
  'private by default',
  'explicit promotion',
  'Forbidden Weakening',
  'Current Codex desktop sessions still enter through `mb-p-gateway`',
  'customer experience should not surface this internal architecture',
  'xlooop-customer-gateway',
  'First call through that connector must be `xlooop.whoami`',
]);

if (pkg.scripts?.['verify:customer-learning-personalization']) {
  pass('package_script_present:verify:customer-learning-personalization');
} else {
  fail('package_script_missing', 'package script verify:customer-learning-personalization is missing');
}

const report = {
  schema_id: 'xlooop.customer_learning_personalization.verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  checks,
  failures,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.status === 'PASS' ? 0 : 1);
