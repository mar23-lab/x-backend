#!/usr/bin/env node
// verify-document-version-chain.mjs · A-W5 · documents version-chain / evidence-integrity gate (260707).
//
// WHY: evidence integrity requires every uploaded document to carry a content_hash (the immutable version
// identity an evidence_items.content_hash can be matched against), and a re-upload to chain to its prior
// version (supersedes_id). A refactor that stopped computing the hash, or dropped the version-chain wiring,
// would silently break the "prove these bytes are the cited bytes" guarantee with no test failing.
//
// THREE teeth:
//   T1 — the upload route computes content_hash (sha256Hex of the bytes) and passes it + the version-chain
//        fields into insertDocumentRow.
//   T2 — insertDocumentRow's INSERT carries content_hash/version/supersedes_id (with the degrade-safe
//        fallback preserved — a legacy insert must still exist for the pre-051 window).
//   T3 — migration 051 defines the three columns + the content_hash backfill.
// Prevention > detection.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = 'src/workers/routes/documents.ts';
const STORE = 'src/workers/lib/document-store.ts';
const MIGRATION = 'src/workers/db/migrations/051_documents_version_chain.sql';

const fail = [];
const read = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { fail.push(`${rel} · not found`); return null; }
  return fs.readFileSync(abs, 'utf8');
};

// T1 · upload route computes + passes the version identity.
const route = read(ROUTE);
if (route) {
  if (!/const contentHash = await sha256Hex\(bytes\)/.test(route)) {
    fail.push(`${ROUTE} · upload no longer computes content_hash via sha256Hex(bytes) — evidence loses its version identity`);
  }
  if (!/content_hash:\s*contentHash/.test(route)) {
    fail.push(`${ROUTE} · content_hash not passed into insertDocumentRow`);
  }
  if (!/getLatestDocumentVersionRow\(/.test(route) || !/supersedes_id:\s*priorVersion/.test(route)) {
    fail.push(`${ROUTE} · re-upload version chaining (getLatestDocumentVersionRow → supersedes_id) removed`);
  }
}

// T2 · the store insert carries the columns AND keeps the degrade-safe legacy fallback.
const store = read(STORE);
if (store) {
  // Match the INSERT COLUMN LIST paren (not the RETURNING clause) — the columns must actually be inserted.
  if (!/INSERT INTO documents \([^)]*content_hash, version, supersedes_id\)/.test(store)) {
    fail.push(`${STORE} · insertDocumentRow no longer inserts content_hash/version/supersedes_id`);
  }
  // The legacy fallback insert (no version-chain columns) must still exist for the migrate→deploy window.
  const legacyInserts = (store.match(/INSERT INTO documents \(id, workspace_id, project_id, filename, content_type, size_bytes, content, extracted_text, uploaded_by, status\)/g) || []).length;
  if (legacyInserts < 1) {
    fail.push(`${STORE} · the degrade-safe legacy insert (pre-051 fallback) was removed`);
  }
  if (!/isMissingDocumentColumn/.test(store)) {
    fail.push(`${STORE} · the missing-column degrade guard was removed`);
  }
}

// T3 · migration 051 defines the columns + deterministic backfill.
const mig = read(MIGRATION);
if (mig) {
  for (const col of ['content_hash', 'version', 'supersedes_id']) {
    if (!new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`).test(mig)) {
      fail.push(`${MIGRATION} · missing ADD COLUMN ${col}`);
    }
  }
  if (!/encode\(sha256\(content\), 'hex'\)/.test(mig)) {
    fail.push(`${MIGRATION} · content_hash backfill (encode(sha256(content),'hex')) missing`);
  }
}

if (fail.length) {
  console.error('✗ document-version-chain · FAIL — document evidence integrity regressed:');
  for (const v of fail) console.error(`    ${v}`);
  console.error('  Every uploaded document must carry a content_hash version identity + chain re-uploads (051). See docs/governance/PRINCIPAL_INSTRUMENT_LINEAGE.md sibling evidence-integrity notes.');
  process.exit(1);
}

console.log('☑ document-version-chain · PASS · content_hash computed on upload · version chain wired · 051 defines columns + backfill');
process.exit(0);
