#!/usr/bin/env node
// S-R3 (260629) · verify:translator-live-verification — a dormant-UNVERIFIED provider translator must
// NOT be exposed/enabled until it is verified against the REAL provider API.
//
// Gmail/Outlook (Wave C S5b) are unit-tested ONLY against an author-authored mock of the provider API
// (authentic shapes, but 0 live calls — the S-D3 integration-blindness). This gate reads the
// TRANSLATOR_VERIFICATION map (src/workers/sources/translators/index.ts) and asserts that any provider
// marked `verified_against_real_api: false` is NOT listed in the connector-registry (the connect UI) —
// so a user cannot connect it + trigger a translator that was never tested against the real API. To
// promote a provider, record a real-API smoke (one live call against a test account) THEN flip the flag.
//
// Static guard + inline self-test, same style as the other verify-*.mjs honesty gates.
//
// Run: node scripts/verify-translator-live-verification.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = 'src/workers/sources/translators/index.ts';
const REGISTRY = 'src/workers/lib/connector-registry.ts';

function read(rel) { try { return readFileSync(resolve(REPO_ROOT, rel), 'utf8'); } catch { return null; } }

// Parse the TRANSLATOR_VERIFICATION object literal (provider: true|false) from index.ts.
function parseVerification(src) {
  const m = src.match(/TRANSLATOR_VERIFICATION[^{]*\{([\s\S]*?)\n\}/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const e = line.match(/^\s*([a-z_]+)\s*:\s*(true|false)/);
    if (e) out[e[1]] = e[2] === 'true';
  }
  return Object.keys(out).length ? out : null;
}

// Is a provider exposed as a connectable id in the connector-registry?
function isExposed(registrySrc, provider) {
  return new RegExp(`id:\\s*['"]${provider}['"]`).test(registrySrc);
}

const failures = [];
const index = read(INDEX);
const registry = read(REGISTRY);
if (!index) failures.push(`translator index missing: ${INDEX}`);
if (!registry) failures.push(`connector-registry missing: ${REGISTRY}`);

let verification = null;
if (index) {
  verification = parseVerification(index);
  if (!verification) failures.push(`${INDEX}: TRANSLATOR_VERIFICATION map not found (S-R3) — every provider must declare verified_against_real_api`);
}

let unverified = [];
if (verification && registry) {
  unverified = Object.entries(verification).filter(([, v]) => v === false).map(([p]) => p);
  for (const provider of unverified) {
    if (isExposed(registry, provider)) {
      failures.push(`${REGISTRY}: provider "${provider}" is exposed in the connector UI, but TRANSLATOR_VERIFICATION marks it verified_against_real_api:false — a user could connect it + run a translator never tested against the real API. Record a real-API smoke + flip the flag first (S-R3).`);
    }
  }
}

// SELF-TEST — prove the gate bites + does not over-fire.
{
  const exposed = "{ id: 'bad', label: 'Bad' }";
  const clean = "{ id: 'good', label: 'Good' }";
  if (!isExposed(exposed, 'bad')) failures.push('self-test: isExposed FAILED to detect an exposed provider');
  if (isExposed(clean, 'bad')) failures.push('self-test: isExposed false-positived on a non-exposed provider');
  const parsed = parseVerification('export const TRANSLATOR_VERIFICATION = {\n  a: true,\n  b: false,\n}');
  if (!parsed || parsed.a !== true || parsed.b !== false) failures.push('self-test: parseVerification mis-parsed a known map');
}

if (failures.length) {
  console.error('✗ verify:translator-live-verification · an unverified provider translator is exposed/enabled');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`☑ verify:translator-live-verification · ${unverified.length} dormant-unverified translator(s) [${unverified.join(', ') || 'none'}] kept out of the connector UI until a real-API smoke is recorded (self-test passed)`);
