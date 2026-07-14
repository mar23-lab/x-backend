#!/usr/bin/env node
// scripts/verify-seed-contract-parity.mjs · Migration-adoption wave (260711).
//
// The frontend seat proposed freezing their seed-data.js as "the canonical fixture both
// seats develop against." Correct instinct (one shared payload shape), WRONG authority
// direction: the backend's declared SSOTs are response-envelope.ts (data_class vocabulary),
// allowed-actions.ts (the authority envelope), and the principal-redaction contract — all
// enforced by blocking gates. If a payload disagreement were resolved in favour of a mock,
// the mock would silently overrule the server. So this gate validates the FRONTEND FIXTURE
// AGAINST backend truth, never the reverse.
//
// Three invariants, all SOURCE-DERIVED (no hardcoded copy of the vocabulary):
//   I1  every payload's data_class ∈ DataClass  (parsed from response-envelope.ts)
//   I2  allowed_actions (if present) is string[]; disabled_reasons (if present) is a
//       Record<string,string>                    (the shape from allowed-actions.ts)
//   I3  no `authorized_by_user_id` anywhere in a payload tagged role ∈ {client,viewer,
//       unknown}                                  (the principal-redaction fail-closed rule)
//
// FIXTURE CONTRACT: Design exports their frozen seed payloads (from seed-data.js →
// XLOOP_SEED) to data/fixtures/frontend-seed-contract.json as:
//   { "_meta": { "source": "seed-data.js@<sha>" },
//     "payloads": [ { "entity": "source", "role": "viewer", "data_class": "live",
//                     "allowed_actions": [...], "disabled_reasons": {...}, "sample": {...} } ] }
// Until that file lands this gate is GREEN-PENDING (harness live, 0 payloads) so it can be
// wired now and bite the moment the fixture arrives — no second commit to "turn it on".
// Dependency-free, matching the repo's no-new-dep posture.
//
//   node scripts/verify-seed-contract-parity.mjs             # gate
//   node scripts/verify-seed-contract-parity.mjs --self-test  # prove every invariant bites

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const RESPONSE_ENVELOPE_TS = 'src/workers/lib/response-envelope.ts';
const FIXTURE = 'data/fixtures/frontend-seed-contract.json';
const REDACTED_ROLES = new Set(['client', 'viewer', 'unknown']);
const FORBIDDEN_KEY = 'authorized_by_user_id';

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** Parse the DataClass union from source so the allowed set can never drift from the server. */
export function parseDataClasses(src) {
  const m = src.match(/export type DataClass\s*=([\s\S]*?);/);
  if (!m) throw new Error(`could not locate DataClass union in ${RESPONSE_ENVELOPE_TS}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

function deepHasKey(value, key) {
  if (Array.isArray(value)) return value.some(v => deepHasKey(v, key));
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true;
    return Object.values(value).some(v => deepHasKey(v, key));
  }
  return false;
}

export function checkPayloads(payloads, dataClasses) {
  const dc = new Set(dataClasses);
  const errors = [];
  payloads.forEach((p, i) => {
    const at = `payloads[${i}]${p.entity ? ` (${p.entity})` : ''}`;
    // I1
    if (!dc.has(p.data_class)) {
      errors.push(`I1 ${at} · data_class ${JSON.stringify(p.data_class)} not in {${[...dc].join(',')}}`);
    }
    // I2
    if (p.allowed_actions !== undefined && !(Array.isArray(p.allowed_actions) && p.allowed_actions.every(a => typeof a === 'string'))) {
      errors.push(`I2 ${at} · allowed_actions must be string[]`);
    }
    if (p.disabled_reasons !== undefined) {
      const dr = p.disabled_reasons;
      if (dr === null || typeof dr !== 'object' || Array.isArray(dr) || !Object.values(dr).every(v => typeof v === 'string')) {
        errors.push(`I2 ${at} · disabled_reasons must be Record<string,string>`);
      }
    }
    // I3
    if (REDACTED_ROLES.has(p.role) && deepHasKey(p, FORBIDDEN_KEY)) {
      errors.push(`I3 ${at} · role=${p.role} payload leaks ${FORBIDDEN_KEY} (principal-redaction fail-closed)`);
    }
  });
  return errors;
}

function selfTest() {
  const dcs = parseDataClasses(read(RESPONSE_ENVELOPE_TS));
  let failures = 0;
  const expect = (name, cond) => { if (!cond) { failures++; console.log(`  ✗ self-test ${name}`); } else console.log(`  ☑ self-test ${name}`); };

  expect('source-has-classes', dcs.includes('live') && dcs.includes('redacted'));
  expect('good-passes', checkPayloads([
    { entity: 'source', role: 'viewer', data_class: 'live', allowed_actions: ['read'], disabled_reasons: { edit: 'not_operator' } },
  ], dcs).length === 0);
  expect('I1-bites', checkPayloads([{ entity: 'x', role: 'owner', data_class: 'bogus' }], dcs).some(e => e.startsWith('I1')));
  expect('I2-bites', checkPayloads([{ entity: 'x', role: 'owner', data_class: 'live', allowed_actions: 'read' }], dcs).some(e => e.startsWith('I2')));
  expect('I2-reasons-bites', checkPayloads([{ entity: 'x', role: 'owner', data_class: 'live', disabled_reasons: { edit: 5 } }], dcs).some(e => e.startsWith('I2')));
  expect('I3-bites', checkPayloads([{ entity: 'x', role: 'viewer', data_class: 'redacted', sample: { nested: { authorized_by_user_id: 'u_1' } } }], dcs).some(e => e.startsWith('I3')));
  expect('I3-owner-ok', checkPayloads([{ entity: 'x', role: 'owner', data_class: 'live', sample: { authorized_by_user_id: 'u_1' } }], dcs).length === 0);
  return failures;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  console.log('verify-seed-contract-parity · 260711');
  const selfTestOnly = process.argv.includes('--self-test');
  // Teeth always run (preamble) so the single ci-local entry enforces both mechanism + state.
  const selfTestFailures = selfTest();
  if (selfTestFailures > 0) {
    console.log(`\n✗ self-test ${selfTestFailures} FAILED — gate mechanism broken`);
    process.exit(1);
  }
  if (selfTestOnly) {
    console.log('\n☑ self-test all invariants bite');
    process.exit(0);
  }
  let dataClasses;
  try {
    dataClasses = parseDataClasses(read(RESPONSE_ENVELOPE_TS));
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    process.exit(1);
  }
  const fixtureAbs = path.join(repoRoot, FIXTURE);
  if (!fs.existsSync(fixtureAbs)) {
    console.log(`  ◦ PENDING · no frontend fixture at ${FIXTURE} (Design exports seed-data.js payloads here)`);
    console.log(`  ☑ harness live · ${dataClasses.length} data_class values source-derived · validates AGAINST backend truth`);
    console.log('\n☑ seed-contract-parity ready (green-pending: 0 payloads)');
    process.exit(0);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(fixtureAbs, 'utf8'));
  } catch (err) {
    console.log(`  ✗ ${FIXTURE} is not valid JSON · ${err.message}`);
    process.exit(1);
  }
  const payloads = Array.isArray(doc.payloads) ? doc.payloads : [];
  const errors = checkPayloads(payloads, dataClasses);
  for (const e of errors) console.log(`  ✗ ${e}`);
  if (errors.length === 0) console.log(`  ☑ ${payloads.length} payload(s) match backend invariants (data_class · authority shape · redaction)`);
  console.log(`\n${errors.length === 0 ? '☑' : '✗'} seed-contract-parity ${errors.length === 0 ? 'green' : `DRIFT · ${errors.length} violation(s)`}`);
  process.exit(errors.length === 0 ? 0 : 1);
}
