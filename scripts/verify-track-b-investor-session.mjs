#!/usr/bin/env node
// scripts/verify-track-b-investor-session.mjs
//
// Track B Stage 1 ci-local gate · GET /api/v1/investor/session — the foundation
// the slim investor app's session shim reads (INVESTOR_PORTAL_PRODUCTION_
// ARCHITECTURE.md §4a/4b). Unblocks the parallel investor-room session.
//
// Guards the SECURITY invariants for an external-facing surface:
//   • caller-SCOPED — the DAL reads WHERE user_id = caller, so the session can
//     never enumerate or leak another user's entitlement.
//   • active-only — revoked entitlements are excluded.
//   • CONTENT-FREE — the session endpoint returns posture (tier/nda/flags) only,
//     never data-room content (which is blocked on the operator-gated safe-pack
//     export). data_room_available must be false.
//   • org-OPTIONAL mount (investors have no workspace org) but JWT-gated (401).
//
// Exit 0 if all pass; 1 otherwise.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFile(path.join(REPO, p), 'utf8');
let passed = 0, failed = 0;
const failures = [];
async function gate(name, fn) {
  try {
    const ok = await fn();
    if (ok === true) { console.log(`  ☑ ${name}`); passed++; }
    else { console.log(`  ✗ ${name} · ${ok}`); failed++; failures.push({ name, reason: ok }); }
  } catch (e) {
    console.log(`  ✗ ${name} · threw ${e.message}`); failed++; failures.push({ name, reason: e.message });
  }
}

console.log('verify-track-b-investor-session · Track B Stage 1 gate\n');

await gate('Track B: DAL reads are CALLER-SCOPED + active-only (no cross-user leak)', async () => {
  const decl = await read('src/workers/dal/DalAdapter.ts');
  if (!/getInvestorEntitlement\(/.test(decl) || !/getLatestNdaAcceptance\(/.test(decl)) return 'DAL methods not declared';
  // Stage 3.1 (F10): the investor entitlement + NDA SQL surfaces moved out of the DAL
  // god-object into ./investor-store; the DAL now thin-delegates. Read the store file for
  // the SQL-scope assertions so the caller-scoping guard follows the feature. Same pattern
  // as the R51-delta-A / inference-store smoke guards.
  const impl = await read('src/workers/dal/investor-store.ts');
  const ent = impl.slice(impl.indexOf('export async function getInvestorEntitlementRow'), impl.indexOf('export async function getInvestorEntitlementRow') + 900);
  if (!/WHERE user_id = \$\{userId\}/.test(ent)) return 'getInvestorEntitlement not scoped to the caller user_id';
  if (!/revoked_at IS NULL/.test(ent)) return 'getInvestorEntitlement does not exclude revoked grants';
  const nda = impl.slice(impl.indexOf('export async function getLatestNdaAcceptanceRow'), impl.indexOf('export async function getLatestNdaAcceptanceRow') + 700);
  if (!/WHERE user_id = \$\{userId\}/.test(nda)) return 'getLatestNdaAcceptance not scoped to the caller user_id';
  return true;
});

await gate('Track B: GET /investor/session returns posture from the DAL, JWT-gated', async () => {
  const src = await read('src/workers/routes/investor.ts');
  if (!/get\('\/investor\/session'/.test(src)) return 'route missing';
  if (!/dal\.getInvestorEntitlement\(userId\)/.test(src)) return 'does not read entitlement';
  if (!/dal\.getLatestNdaAcceptance\(userId\)/.test(src)) return 'does not read NDA';
  if (!/if \(!userId\)[\s\S]{0,120}ctx\.status\(401\)/.test(src)) return 'not JWT-gated (no 401 when unauthenticated)';
  if (!/tier:\s*ent\?\.tier/.test(src)) return 'does not surface tier';
  if (!/nda_accepted:\s*!!nda/.test(src)) return 'does not surface nda_accepted';
  return true;
});

await gate('Track B: session is CONTENT-FREE (no data-room content; data_room_available=false)', async () => {
  const src = await read('src/workers/routes/investor.ts');
  if (!/data_room_available:\s*false/.test(src)) return 'does not advertise data_room_available:false (content gate)';
  // The session endpoint must NOT ship data-room content. Reject obvious content keys.
  if (/financial_model|pitch_deck|sections:\s*\[|data_room:\s*\{/.test(src)) return 'session endpoint leaks data-room content (must stay posture-only until safe-pack export)';
  // And the content endpoints must NOT be ROUTE-DEFINED yet (blocked on the
  // operator-gated export). Match an actual handler — not the comment that names
  // them to document the deferral (over-broad negative-assertion lesson).
  if (/\.(get|post|patch|put|delete)\(\s*['"]\/investor\/(data-room|ops-stream)['"]/.test(src)) return 'content endpoints route-defined — they are blocked on the operator-gated safe-pack export';
  return true;
});

await gate('Track B: route mounted ORG-OPTIONAL (investors have no workspace org)', async () => {
  const idx = await read('src/workers/index.ts');
  if (!/import \{ investorRoute \}/.test(idx)) return 'investorRoute not imported';
  const grp = idx.slice(idx.indexOf('const investorRoutes ='), idx.indexOf('const investorRoutes =') + 300);
  if (!/clerkAuth\(\{ requireOrg: false \}\)/.test(grp)) return 'investor group not org-optional';
  if (!/investorRoutes\.route\('\/', investorRoute\)/.test(grp)) return 'investorRoute not mounted in the group';
  return true;
});

await gate('Track B: built worker bundle carries the investor session route', async () => {
  const p = 'dist-workers-dryrun/index.js';
  if (!existsSync(path.join(REPO, p))) return 'dry-run bundle missing — run `npm run deploy:api:dryrun`';
  const b = await read(p);
  if (!b.includes('xlooop.investor_session.v1')) return 'investor session route not in the worker bundle';
  return true;
});

console.log(`\nverify-track-b-investor-session · ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name} · ${f.reason}`);
  process.exit(1);
}
process.exit(0);
