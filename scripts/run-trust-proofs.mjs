#!/usr/bin/env node
// scripts/run-trust-proofs.mjs
//
// ONE command for the two P0 backend trust proofs (docs/frontend-migration/22_BACKEND_COMPLETENESS.md
// §4/§5-P1.3): tenant/projection isolation + token revocation. The proofs and their infrastructure
// already exist and are cited in doc 22; this orchestrator runs them together and — critically —
// FAILS HONESTLY when the operator inputs required for the LIVE round-trip are absent. It never
// prints a false PASS and never silently skips: a missing DSN is an explicit OPERATOR-INPUT-REQUIRED
// exit, not a green.
//
// WHY THIS EXISTS: the static-marker proofs (source wiring) run in ci-local today, but §5-P1.3 asks
// for the proofs to run as hard gates ON PROD-SHAPED DATA (live DB round-trips) — which needs a
// disposable DB DSN only the operator can supply. This makes that a single, pre-staged command.
//
// USAGE
//   Static wiring proofs only (no DB needed — runs in CI already):
//     node scripts/run-trust-proofs.mjs
//   Full LIVE proofs (operator, against a DISPOSABLE prod-shaped DB — never real prod):
//     XLOOOP_RUN_LIVE_RLS=1 DATABASE_URL='postgres://…disposable…' node scripts/run-trust-proofs.mjs --live
//
// The DATABASE_URL MUST point at a throwaway/disposable branch seeded with prod-shaped tenants
// (e.g. a Neon dev branch), NEVER the production database. The live-RLS test connects with the
// xlooop_app NON-OWNER role to prove RLS bites (migration 034/037). See doc 22 §4.

import { spawnSync } from 'node:child_process';

const LIVE = process.argv.includes('--live');
const hasDsn = !!process.env.DATABASE_URL;
const liveArmed = process.env.XLOOOP_RUN_LIVE_RLS === '1' && hasDsn;

function run(label, cmd, args, env = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  const ok = res.status === 0;
  console.log(`  ${ok ? '☑ PASS' : '✗ FAIL'} · ${label}`);
  return ok;
}

console.log('══════════════════════════════════════════════════════════════');
console.log(' Xlooop backend trust proofs — tenant isolation + token revocation');
console.log('══════════════════════════════════════════════════════════════');

const results = [];

// ── Static wiring proofs (always runnable; already in ci-local) ──────────────
results.push(['tenant-bundle-isolation (static wiring)',
  run('Tenant/projection isolation — source wiring', 'npm', ['run', '--silent', 'verify:tenant-bundle-isolation'])]);
results.push(['customer-revocation (static wiring)',
  run('Token revocation — source wiring', 'npm', ['run', '--silent', 'verify:customer-revocation-end-to-end'])]);

// ── LIVE round-trip proof (operator-gated) ──────────────────────────────────
if (LIVE) {
  if (!liveArmed) {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.error('✗ OPERATOR-INPUT-REQUIRED — the LIVE tenant-isolation proof cannot run.');
    console.error('  Missing:' + (hasDsn ? '' : ' DATABASE_URL') +
      (process.env.XLOOOP_RUN_LIVE_RLS === '1' ? '' : ' XLOOOP_RUN_LIVE_RLS=1'));
    console.error('  Provide a DISPOSABLE prod-shaped DB DSN (NEVER production) and re-run:');
    console.error("    XLOOOP_RUN_LIVE_RLS=1 DATABASE_URL='postgres://…disposable…' \\");
    console.error('      node scripts/run-trust-proofs.mjs --live');
    console.error('  This is NOT a pass — the runtime isolation-on-prod-data proof is still owed.');
    process.exit(2);
  }
  results.push(['operational-spine-live-rls (LIVE round-trip)',
    run('Tenant isolation — LIVE RLS round-trip (xlooop_app non-owner role bites)',
      'npm', ['run', '--silent', 'verify:operational-spine-live-rls'])]);
} else {
  console.log('\nℹ  LIVE round-trip proof NOT run (pass --live + XLOOOP_RUN_LIVE_RLS=1 + DATABASE_URL).');
  console.log('   Static wiring proves the seams are present; it does NOT prove runtime isolation on');
  console.log('   prod-shaped data — that live proof (doc 22 §5-P1.3) remains OPERATOR-INPUT-GATED.');
}

console.log('\n══════════════════════════════════════════════════════════════');
const failed = results.filter(([, ok]) => !ok);
for (const [label, ok] of results) console.log(`  ${ok ? '☑' : '✗'} ${label}`);
if (failed.length) { console.error(`\n✗ ${failed.length} proof(s) FAILED.`); process.exit(1); }
console.log(`\n☑ ${results.length}/${results.length} proofs passed${LIVE ? ' (incl. LIVE round-trip)' : ' (static wiring only — LIVE still owed)'}.`);
