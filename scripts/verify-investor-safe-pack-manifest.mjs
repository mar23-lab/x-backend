#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xBizRoot = process.env.X_BIZ_ROOT || path.resolve(repoRoot, '..', 'x-biz');
const failures = [];

const manifest = json('data/investor-safe-pack-manifest.example.json');
const authority = json('data/investor-data-room-authority.json');
const packageJson = json('package.json');

check('schema', manifest.schema_version === 'xlooop.investor_safe_pack_manifest.v1');
check('draft_only', manifest.status === 'draft_not_exported' && manifest.portal_active === false);
check('operator_required', manifest.operator_decision_required === true);
check('public_not_claimed', manifest.public_claim_status === 'not_claimed');
check('source_xbiz', manifest.source_domain === 'x-biz' && authority.content_authority?.source_domain === 'x-biz');
check('authority_path_parity', arrayEquals(manifest.allowed_source_paths || [], authority.content_authority?.allowed_source_paths || []));
check('source_binding_gate_scripted', packageJson.scripts?.['verify:xbiz-investor-readiness-source-binding']);
for (const gate of ['verify:xbiz-investor-readiness-source-binding', 'verify:investor-data-room-authority', 'claim_safety_review', 'redaction_scan', 'legal_or_nondisclosure_reference', 'owner_signoff']) {
  check(`required_check:${gate}`, (manifest.required_checks_before_export || []).includes(gate));
}
for (const forbidden of ['raw MB-P private governance', 'XCP private control-plane internals', 'raw tenant/customer data', 'secrets or local paths']) {
  check(`forbidden:${forbidden}`, (manifest.forbidden_content || []).includes(forbidden));
}
for (const rel of manifest.allowed_source_paths || []) {
  check(`xbiz_source_exists:${rel}`, fs.existsSync(path.join(xBizRoot, rel)));
}

if (failures.length) {
  console.error('verify-investor-safe-pack-manifest: FAIL');
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}

console.log('verify-investor-safe-pack-manifest: PASS (draft investor pack manifest is x-biz sourced and operator-gated)');

function json(rel) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
}

function check(id, ok) {
  if (!ok) failures.push(id);
}

function arrayEquals(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
