#!/usr/bin/env node
// scripts/verify-tenant-source-isolation.mjs · ADR-XLOOP-IA-001 R2 · HR-PLATFORM-VS-INSTANCE-1 (F1-exposure)
//
// WHY
//   A per-tenant deploy bundle is a STATIC Cloudflare Pages site (index.html + dist/*.js + data/).
//   The shared worker backend lives at api.xlooop.com — a customer's static bundle has no reason
//   to carry the worker SOURCE. Yet a tenant manifest's `passthrough_dirs` copies dirs VERBATIM
//   (no workspace filter). If a CUSTOMER (non-operator) manifest passes through `src/`, the
//   operator's construction IP — the lens engine, the detector-config seed SQL, the cockpit
//   chat-bridge — ships into the customer bundle and could be served publicly. The DATA is
//   filtered; the SOURCE was not. This gate makes that a blocking defect.
//
// RULE
//   Only the OPERATOR deploy (a manifest that owns the operator workspace `mbp-private`) may
//   passthrough operator worker source. A non-operator (customer) manifest MUST NOT passthrough
//   any operator-private source dir (`src/`, `scripts/`, `migrations`). Customers get dist/ + data/.
//
// EXIT 0 = isolated · EXIT 1 = a customer manifest ships operator source. `--self-test` proves the bite.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const MANIFEST_DIR = path.join(repoRoot, 'data', '_tenant-manifests');

// The operator workspace whose presence marks a manifest as the operator's own deploy.
const OPERATOR_WORKSPACE = 'mbp-private';
// Source dirs that carry operator construction IP and must never reach a customer bundle.
const OPERATOR_SOURCE_DIRS = ['src/', 'src', 'scripts/', 'scripts'];

function isOperatorManifest(m) {
  return Array.isArray(m.owned_workspaces) && m.owned_workspaces.includes(OPERATOR_WORKSPACE);
}

function offendingDirs(m) {
  const pd = m.passthrough_dirs || [];
  return pd.filter((d) => OPERATOR_SOURCE_DIRS.includes(String(d)));
}

function evaluate(manifests) {
  const fails = [];
  for (const { id, m } of manifests) {
    if (isOperatorManifest(m)) continue; // the operator's own deploy may carry operator source
    const bad = offendingDirs(m);
    if (bad.length) fails.push(`${id}: customer manifest passthroughs operator source ${JSON.stringify(bad)} — strip to dist/ + data/ only`);
  }
  return fails;
}

if (process.argv.includes('--self-test')) {
  const customerWithSrc = [{ id: 'fake-customer', m: { owned_workspaces: ['cust'], passthrough_dirs: ['dist/', 'src/'] } }];
  const customerClean = [{ id: 'fake-customer', m: { owned_workspaces: ['cust'], passthrough_dirs: ['dist/', 'data/schemas/'] } }];
  const operatorWithSrc = [{ id: 'op', m: { owned_workspaces: ['mbp-private'], passthrough_dirs: ['dist/', 'src/'] } }];
  const bites = evaluate(customerWithSrc).length === 1;
  const cleanPasses = evaluate(customerClean).length === 0;
  const operatorAllowed = evaluate(operatorWithSrc).length === 0;
  if (bites && cleanPasses && operatorAllowed) { console.log('☑ self-test: customer+src FAILS · customer-clean passes · operator+src allowed'); process.exit(0); }
  console.error(`✗ self-test: bites=${bites} cleanPasses=${cleanPasses} operatorAllowed=${operatorAllowed}`); process.exit(1);
}

let manifests = [];
try {
  for (const f of fs.readdirSync(MANIFEST_DIR)) {
    if (!f.endsWith('.json')) continue;
    const m = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, f), 'utf8'));
    manifests.push({ id: f.replace(/\.json$/, ''), m });
  }
} catch (e) {
  console.error(`✗ cannot read tenant manifests at ${MANIFEST_DIR}: ${e.message}`);
  process.exit(1);
}

const fails = evaluate(manifests);
console.log('R2 · tenant source isolation (HR-PLATFORM-VS-INSTANCE-1 · F1-exposure)');
console.log('─'.repeat(64));
const ops = manifests.filter(({ m }) => isOperatorManifest(m)).map((x) => x.id);
const custs = manifests.filter(({ m }) => !isOperatorManifest(m)).map((x) => x.id);
console.log(`  operator manifests: ${ops.join(', ') || '(none)'} · customer manifests: ${custs.join(', ') || '(none)'}`);
if (fails.length) {
  console.error('─'.repeat(64));
  console.error(`✗ tenant source isolation BROKEN · ${fails.length} customer bundle(s) ship operator source:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('─'.repeat(64));
console.log('☑ no customer tenant bundle passes through operator worker source (dist/ + data/ only)');
process.exit(0);
