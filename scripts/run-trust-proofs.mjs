#!/usr/bin/env node
// scripts/run-trust-proofs.mjs
//
// ONE command for the backend trust proofs: tenant source isolation, token revocation, and optional
// live RLS shadow proof. The demo has a separate tenant-bundle verifier; this backend orchestrator
// deliberately uses only repo-local x-backend proof scripts so donor absorption does not create a
// hidden dependency on Xlooop-XCP-demo.
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
import fs from 'node:fs';

const LIVE = process.argv.includes('--live');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const liveMissing = [
  !process.env.DATABASE_URL ? 'DATABASE_URL' : null,
  !process.env.XLOOOP_RLS_APP_DATABASE_URL ? 'XLOOOP_RLS_APP_DATABASE_URL' : null,
].filter(Boolean);

function run(label, cmd, args, env = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  const ok = res.status === 0;
  console.log(`  ${ok ? '☑ PASS' : '✗ FAIL'} · ${label}`);
  return ok;
}

function runNpmScript(label, scriptName, env = {}) {
  if (!pkg.scripts?.[scriptName]) {
    console.error(`\n✗ package script missing: ${scriptName}`);
    console.error('  Trust proof orchestration is stale; add the package script or remove the gate explicitly.');
    return false;
  }
  return run(label, 'npm', ['run', '--silent', scriptName], env);
}

console.log('══════════════════════════════════════════════════════════════');
console.log(' Xlooop backend trust proofs — tenant isolation + token revocation');
console.log('══════════════════════════════════════════════════════════════');

const results = [];

// ── Static wiring proofs (always runnable) ──────────────────────────────────
results.push(['tenant-source-isolation (static wiring)',
  runNpmScript('Tenant source isolation — backend-local wiring', 'verify:tenant-source-isolation')]);
results.push(['customer-revocation-end-to-end (static authorization model)',
  runNpmScript('Token revocation — customer API/MCP authorization model', 'verify:customer-revocation-end-to-end')]);

// ── LIVE round-trip proof (operator-gated) ──────────────────────────────────
if (LIVE) {
  if (liveMissing.length) {
    console.log('\n──────────────────────────────────────────────────────────────');
    console.error('✗ OPERATOR-INPUT-REQUIRED — the LIVE tenant-isolation proof cannot run.');
    console.error(`  Missing: ${liveMissing.join(', ')}`);
    console.error('  Provide DISPOSABLE prod-shaped owner + xlooop_app DB URLs (NEVER production) and re-run:');
    console.error("    DATABASE_URL='postgres://…owner…' XLOOOP_RLS_APP_DATABASE_URL='postgres://…xlooop_app…' \\");
    console.error('      npm run verify:trust-proofs:live');
    console.error('  This is NOT a pass — the runtime isolation-on-prod-data proof is still owed.');
    process.exit(2);
  }
  results.push(['operational-spine-live-rls (LIVE round-trip)',
    runNpmScript('Tenant isolation — LIVE RLS route round-trip',
      'verify:operational-spine-live-rls', { XLOOOP_RUN_LIVE_RLS: '1' })]);
  results.push(['rls-shadow-soak (LIVE owner/app parity + leak check)',
    runNpmScript('Tenant isolation — LIVE shadow soak owner/app parity',
      'verify:rls-shadow-soak', { XLOOOP_STRICT_PROOF: '1' })]);
} else {
  console.log('\nℹ  LIVE round-trip proof NOT run (pass --live + DATABASE_URL + XLOOOP_RLS_APP_DATABASE_URL).');
  console.log('   Static wiring proves the seams are present; it does NOT prove runtime isolation on');
  console.log('   prod-shaped data — that live proof (doc 22 §5-P1.3) remains OPERATOR-INPUT-GATED.');
}

console.log('\n══════════════════════════════════════════════════════════════');
const failed = results.filter(([, ok]) => !ok);
for (const [label, ok] of results) console.log(`  ${ok ? '☑' : '✗'} ${label}`);
if (failed.length) { console.error(`\n✗ ${failed.length} proof(s) FAILED.`); process.exit(1); }
console.log(`\n☑ ${results.length}/${results.length} proofs passed${LIVE ? ' (incl. LIVE round-trip)' : ' (static wiring only — LIVE still owed)'}.`);
