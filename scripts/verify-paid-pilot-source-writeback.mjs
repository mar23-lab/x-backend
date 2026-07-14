#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const policy = json('data/paid-pilot-action-policy.json');
const adapter = read('scripts/apply-paid-pilot-markdown-writeback.mjs');
const migration = read('migrations/0003_paid_pilot_authority.sql');
const sourceContract = json('data/markdown-source-writeback-contract.json');

const request = policy.allowed_actions.find((entry) => entry.action_type === 'document.markdown.writeback.request');
const apply = policy.allowed_actions.find((entry) => entry.action_type === 'document.markdown.writeback.apply');
check('markdown_contract_existing_browser_block', sourceContract.browser_direct_write_allowed === false && sourceContract.source_file_overwrite_allowed_from_browser === false);
check('request_action_present', request?.source_kind === 'markdown' && request.receipt_policy === 'proposal_first_required');
check('apply_action_present', apply?.source_kind === 'markdown' && apply.receipt_policy === 'verifier_and_rollback_required');
check('pdf_docx_blocked', policy.blocked_actions.includes('document.pdf.writeback.apply') && policy.blocked_actions.includes('document.docx.writeback.apply'));
check('mbp_governance_blocked', policy.blocked_actions.includes('mbp.governance.write'));
check('receipt_table', migration.includes('paid_pilot_source_writeback_receipts'));
for (const field of ['source_repo', 'source_path', 'source_kind', 'before_hash', 'after_hash', 'patch_hash', 'approval_ref', 'commit_ref', 'verifier_ref', 'rollback_ref', 'collaboration_claim_id']) {
  check(`writeback_receipt_field:${field}`, migration.includes(field));
}
check('adapter_requires_action_id', adapter.includes('--action-id') && adapter.includes('action id is required'));
check('adapter_requires_cloudflare_env', adapter.includes('CLOUDFLARE_API_TOKEN') && adapter.includes('CLOUDFLARE_ACCOUNT_ID'));
check('adapter_requires_claim', adapter.includes('XLOOOP_COLLABORATION_CLAIM_ID') && adapter.includes('collaboration claim'));
check('adapter_markdown_only', adapter.includes("source_kind !== 'markdown'") || adapter.includes('Markdown only'));
check('adapter_no_main_write', adapter.includes('dedicated branch') && adapter.includes('main branch is not a write target'));
check('adapter_verifier_rollback', adapter.includes('verifier_ref') && adapter.includes('rollback_ref'));

finish('verify-paid-pilot-source-writeback');

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
