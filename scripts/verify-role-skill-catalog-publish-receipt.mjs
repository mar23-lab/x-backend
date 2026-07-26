#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRows,
  parseCatalog,
  sha256Hex,
  validateCatalog,
} from './lib/role-skill-catalog.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = 'docs/contracts/role-skill-catalog.json';
const receiptPath = 'docs/audits/receipts/role-skill-catalog-publish-d814f1a4.json';
const hex64 = /^[a-f0-9]{64}$/;
const gitBlob = /^[a-f0-9]{40}$/;
const hostname = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

function sameJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function assessReceipt({ receipt, catalog, sourceSha, now = Date.now() }) {
  const failures = [];
  const fail = (condition, message) => {
    if (!condition) failures.push(message);
  };

  fail(receipt.schema_id === 'xlooop.role_skill_catalog_publish_receipt.v1', 'unexpected receipt schema_id');
  fail(receipt.catalog_version === catalog.catalog_version, 'catalog_version does not match the canonical catalog');
  fail(gitBlob.test(receipt.source_sha ?? ''), 'source_sha must be a 40-character Git blob hash');
  fail(receipt.source_sha === sourceSha, 'source_sha does not match the canonical catalog Git blob');
  fail(typeof receipt.approval_ref === 'string' && receipt.approval_ref.length > 0, 'approval_ref is required');
  fail(typeof receipt.approved_by === 'string' && receipt.approved_by.length > 0, 'approved_by is required');
  fail(receipt.workspace_binding === null, 'publication receipt must not claim a workspace binding');
  fail(hex64.test(receipt.catalog_sha256 ?? ''), 'catalog_sha256 must be a 64-character SHA-256');

  const rows = buildRows(catalog, {
    sourceSha,
    approvalRef: receipt.approval_ref,
  });
  const expectedCatalogSha = sha256Hex(rows.map((row) => row.content_sha256).join('\n'));
  const expectedEntries = rows.map(({ key, category, version, content_sha256 }) => ({
    key,
    category,
    version,
    content_sha256,
  }));
  const expectedPublished = rows.map((row) => `${row.key}@${row.version}`);

  fail(receipt.catalog_sha256 === expectedCatalogSha, 'catalog_sha256 does not match canonical entry hashes');
  fail(sameJson(receipt.entries, expectedEntries), 'entries do not exactly match the canonical ordered catalog');
  fail(sameJson(receipt.published, expectedPublished), 'published list is not the complete canonical catalog');

  const appliedAt = Date.parse(receipt.applied_at);
  fail(Number.isFinite(appliedAt), 'applied_at must be a valid ISO timestamp');
  fail(!Number.isFinite(appliedAt) || appliedAt <= now + 5 * 60 * 1000, 'applied_at is in the future');
  fail(
    typeof receipt.target_host === 'string'
      && hostname.test(receipt.target_host)
      && !receipt.target_host.includes('://')
      && !receipt.target_host.includes('@'),
    'target_host must be a credential-free hostname',
  );

  return {
    failures,
    entries: rows.length,
    catalogSha: expectedCatalogSha,
    sourceSha,
  };
}

function loadInputs() {
  const catalogText = readFileSync(resolve(repoRoot, catalogPath), 'utf8');
  const catalog = parseCatalog(catalogText);
  const agentRoles = readFileSync(resolve(repoRoot, 'docs/contracts/agent-roles.yml'), 'utf8');
  const agentKeys = [...agentRoles.matchAll(/^\s*"([^"]+)":\s*$/gm)].map((match) => match[1]);
  const catalogFailures = validateCatalog(catalog, { agentKeys });
  if (catalogFailures.length > 0) {
    throw new Error(`canonical catalog is invalid: ${catalogFailures.join('; ')}`);
  }

  const sourceSha = execFileSync('git', ['hash-object', catalogPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const receipt = JSON.parse(readFileSync(resolve(repoRoot, receiptPath), 'utf8'));
  return { receipt, catalog, sourceSha };
}

function assertRejected(inputs, mutate, expectedFailure) {
  const candidate = structuredClone(inputs.receipt);
  mutate(candidate);
  const result = assessReceipt({ ...inputs, receipt: candidate });
  if (!result.failures.some((failure) => failure.includes(expectedFailure))) {
    throw new Error(`self-test did not reject ${expectedFailure}`);
  }
}

try {
  const inputs = loadInputs();
  const result = assessReceipt(inputs);
  if (result.failures.length > 0) {
    throw new Error(result.failures.join('; '));
  }

  if (process.argv.includes('--self-test')) {
    assertRejected(inputs, (receipt) => {
      receipt.catalog_sha256 = '0'.repeat(64);
    }, 'catalog_sha256 does not match');
    assertRejected(inputs, (receipt) => {
      receipt.entries[0].content_sha256 = '0'.repeat(64);
    }, 'entries do not exactly match');
    assertRejected(inputs, (receipt) => {
      receipt.workspace_binding = 'ws_unverified';
    }, 'must not claim a workspace binding');
    console.log('PASS role/skill publication receipt negative controls (3/3)');
  }

  console.log(
    `PASS role/skill publication receipt source integrity `
      + `(entries=${result.entries}, catalog_sha=${result.catalogSha.slice(0, 8)}, source_sha=${result.sourceSha.slice(0, 8)}); `
      + 'database effect and workspace bindings require live SELECT verification',
  );
} catch (error) {
  console.error(`FAIL role/skill publication receipt: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
