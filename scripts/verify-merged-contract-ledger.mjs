#!/usr/bin/env node
// scripts/verify-merged-contract-ledger.mjs · 260711-H Phase 2a.
//
// THE MERGED LEDGER DRIFT GATE — one keyed truth across the three former count surfaces:
//   (1) the Design seat's FRONTIER manifest (pinned copy, consumer-pins pattern),
//   (2) the backend ledger (backend-ui-contract-ledger-260709.json, 111 actions),
//   (3) the reconciliation SSOT doc (DESIGN-STAGE0-CONTRACT-RECONCILIATION-260711.md).
// The manifest self-declares as a PROJECTION (§223); this gate makes that machine-true: if any
// surface drifts from the invariants below, ci-local fails instead of three counts diverging.
//
// INVARIANTS:
//   L1  pinned manifest: totals.distinctContracts == 124 == sum(frontier[domain].ids);
//       totals.domains == 12; sum(mocked) == reconcile.clerkMocked; sum(backend) == reconcile.needRoute.
//   L2  reconcile block: frontendIds - clerkMocked == needRoute; backendLedgerActions == the ACTUAL
//       row count of the backend ledger file; ssot doc EXISTS in-repo.
//   L3  consultFirst: every row status == 'decided' (ratified 260711); count == totals.consultFirst.
//   L4  idempotency block: status 'decided' + the backend mechanism EXISTS (migration 065 +
//       lib/idempotency.ts) — the §225 decision is not prose, it is built.
//   R2  FRESHNESS (WARN, never fail): if the sibling x-ai-front export is present on disk and its
//       FRONTIER manifest hash differs from the pinned copy → WARN to re-pin (kills the
//       stale-export-analysis class; soft because the sibling may legitimately be absent).
//
//   node scripts/verify-merged-contract-ledger.mjs            # gate
//   node scripts/verify-merged-contract-ledger.mjs --self-test # prove the teeth bite

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const PINNED = 'data/fixtures/FRONTIER-MANIFEST-260711.pinned.json';
const BACKEND_LEDGER = 'docs/frontend-migration/precutover-hardening/backend-ui-contract-ledger-260709.json';
const SSOT_DOC = 'docs/frontend-migration/precutover-hardening/DESIGN-STAGE0-CONTRACT-RECONCILIATION-260711.md';
const SIBLING_MANIFEST = '/Users/maratbasyrov/WIP/Xlooop/x-ai-front/project/handoff/FRONTIER-MANIFEST-260711.json';
const BACKEND_IDEMPOTENCY = ['src/workers/lib/idempotency.ts', 'src/workers/db/migrations/065_idempotency_keys.sql'];

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

export function runChecks({ manifest, backendLedger, ssotExists, idempotencyFilesExist }) {
  const errors = [];
  const warns = [];
  const t = manifest.totals || {};
  const frontier = manifest.frontier || {};
  const rec = manifest.reconcile || {};

  // L1 — internal consistency of the manifest
  const idsSum = Object.values(frontier).reduce((a, d) => a + (d.ids || 0), 0);
  const mockedSum = Object.values(frontier).reduce((a, d) => a + (d.mocked || 0), 0);
  const backendSum = Object.values(frontier).reduce((a, d) => a + (d.backend || 0), 0);
  if (t.distinctContracts !== idsSum) errors.push(`L1 totals.distinctContracts ${t.distinctContracts} != sum(frontier.ids) ${idsSum}`);
  if (t.domains !== Object.keys(frontier).length) errors.push(`L1 totals.domains ${t.domains} != frontier domain count ${Object.keys(frontier).length}`);
  if (rec.clerkMocked !== mockedSum) errors.push(`L1 reconcile.clerkMocked ${rec.clerkMocked} != sum(frontier.mocked) ${mockedSum}`);
  if (rec.needRoute !== backendSum) errors.push(`L1 reconcile.needRoute ${rec.needRoute} != sum(frontier.backend) ${backendSum}`);

  // L2 — cross-surface: reconcile block vs the real backend ledger + the SSOT doc
  if (rec.frontendIds - rec.clerkMocked !== rec.needRoute) errors.push(`L2 frontendIds-clerkMocked ${rec.frontendIds - rec.clerkMocked} != needRoute ${rec.needRoute}`);
  const ledgerCount = (backendLedger.actions || []).length;
  if (rec.backendLedgerActions !== ledgerCount) errors.push(`L2 reconcile.backendLedgerActions ${rec.backendLedgerActions} != actual backend ledger rows ${ledgerCount}`);
  if (!ssotExists) errors.push(`L2 reconcile.ssot doc missing in-repo: ${SSOT_DOC}`);

  // L3 — consult rows all decided
  const consult = manifest.consultFirst || [];
  if (consult.length !== t.consultFirst) errors.push(`L3 consultFirst length ${consult.length} != totals.consultFirst ${t.consultFirst}`);
  const open = consult.filter(c => c.status !== 'decided');
  if (t.open !== 0 || open.length > 0) errors.push(`L3 open consult rows: totals.open=${t.open}, undecided=${open.map(c => c.id).join(',') || 'none'}`);

  // L4 — the idempotency decision is BUILT, not prose
  if (!manifest.idempotency || !String(manifest.idempotency.status || '').includes('decided')) {
    errors.push('L4 manifest.idempotency missing or not decided');
  }
  if (!idempotencyFilesExist) errors.push('L4 backend idempotency mechanism files missing (lib/idempotency.ts / migration 065)');

  return { errors, warns, counts: { ids: idsSum, mocked: mockedSum, backend: backendSum, ledger: ledgerCount, consult: consult.length } };
}

function freshnessWarn() {
  try {
    if (!fs.existsSync(SIBLING_MANIFEST)) return null; // sibling absent — nothing to compare (soft)
    const pinnedHash = crypto.createHash('sha256').update(read(PINNED)).digest('hex');
    const liveHash = crypto.createHash('sha256').update(fs.readFileSync(SIBLING_MANIFEST)).digest('hex');
    if (pinnedHash !== liveHash) {
      return `R2 FRESHNESS: pinned manifest differs from the live x-ai-front export — re-pin (cp '${SIBLING_MANIFEST}' ${PINNED}) and re-run`;
    }
    return null;
  } catch { return null; }
}

function selfTest() {
  const manifest = JSON.parse(read(PINNED));
  const ledger = JSON.parse(read(BACKEND_LEDGER));
  let failures = 0;
  const expect = (name, cond) => { if (!cond) { failures++; console.log(`  ✗ self-test ${name}`); } else console.log(`  ☑ self-test ${name}`); };
  const base = { manifest, backendLedger: ledger, ssotExists: true, idempotencyFilesExist: true };
  expect('baseline-green', runChecks(base).errors.length === 0);
  expect('L1-bites', runChecks({ ...base, manifest: { ...manifest, totals: { ...manifest.totals, distinctContracts: 999 } } }).errors.some(e => e.startsWith('L1')));
  expect('L2-bites', runChecks({ ...base, backendLedger: { actions: [] } }).errors.some(e => e.startsWith('L2')));
  const undecided = { ...manifest, consultFirst: manifest.consultFirst.map((c, i) => i === 0 ? { ...c, status: 'open' } : c) };
  expect('L3-bites', runChecks({ ...base, manifest: undecided }).errors.some(e => e.startsWith('L3')));
  expect('L4-bites', runChecks({ ...base, idempotencyFilesExist: false }).errors.some(e => e.startsWith('L4')));
  return failures;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  console.log('verify-merged-contract-ledger · 260711-H');
  const failures = selfTest();
  if (failures > 0) { console.log(`\n✗ self-test ${failures} FAILED — gate mechanism broken`); process.exit(1); }
  if (process.argv.includes('--self-test')) { console.log('\n☑ self-test all teeth bite'); process.exit(0); }
  const manifest = JSON.parse(read(PINNED));
  const ledger = JSON.parse(read(BACKEND_LEDGER));
  const result = runChecks({
    manifest, backendLedger: ledger,
    ssotExists: fs.existsSync(path.join(repoRoot, SSOT_DOC)),
    idempotencyFilesExist: BACKEND_IDEMPOTENCY.every(f => fs.existsSync(path.join(repoRoot, f))),
  });
  const fresh = freshnessWarn();
  if (fresh) console.log(`  ⚠ ${fresh}`);
  for (const e of result.errors) console.log(`  ✗ ${e}`);
  if (result.errors.length === 0) {
    console.log(`  ☑ merged ledger coherent · ${result.counts.ids} frontend ids · ${result.counts.mocked} Clerk-mocked · ${result.counts.backend} need-route · ${result.counts.ledger} backend actions · ${result.counts.consult}/9 consult decided`);
  }
  console.log(`\n${result.errors.length === 0 ? '☑' : '✗'} merged-contract-ledger ${result.errors.length === 0 ? 'in sync' : `DRIFT · ${result.errors.length} error(s)`}`);
  process.exit(result.errors.length === 0 ? 0 : 1);
}
