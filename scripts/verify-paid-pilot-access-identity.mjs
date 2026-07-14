#!/usr/bin/env node
// verify-paid-pilot-access-identity.mjs
//
// Behavioral guard for the paid-pilot CF Access identity resolver.
//
// Why this gate exists: the strict-paid-pilot evidence receipt authenticates its
// POSITIVE smoke check (`access_signed_jwt_positive`) with a Cloudflare Access
// SERVICE TOKEN. CF Access service-token JWTs carry the principal in `common_name`
// (the full Client ID) with an EMPTY `sub` and NO `email` claim. An earlier
// resolver read only `email || sub`, so a service token resolved to an empty
// identity and the endpoint failed closed with `access_jwt_email_missing` — the
// positive check could never pass, regardless of what was seeded in D1.
//
// This gate imports the real exported helper and asserts every credential type
// resolves, so the service-token path cannot silently regress.

import { pickAccessIdentityEmail } from '../functions/_lib/paid-pilot-authority.js';

const cases = [
  // [label, payload, expectedEmail]
  ['human SSO session (email claim)', { email: 'Operator@Xlooop.com', sub: 'sub-123' }, 'operator@xlooop.com'],
  ['sub-only configuration', { sub: 'cd397f00-9060-4430-ac85-c049f3174a78' }, 'cd397f00-9060-4430-ac85-c049f3174a78'],
  ['CF Access service token (common_name, empty sub, no email)', { sub: '', common_name: '8dd92438F5e83adb8d85322c5b950702.access' }, '8dd92438f5e83adb8d85322c5b950702.access'],
  ['service token (sub undefined)', { common_name: 'token-client-id.access' }, 'token-client-id.access'],
  ['precedence: email beats sub beats common_name', { email: 'a@x.com', sub: 'b', common_name: 'c.access' }, 'a@x.com'],
  ['no identifying claim → empty (fails closed upstream)', { aud: ['x'], iss: 'y' }, ''],
  ['null payload → empty', null, ''],
  ['non-object payload → empty', 'not-an-object', ''],
];

let failures = 0;
for (const [label, payload, expected] of cases) {
  let actual;
  try {
    actual = pickAccessIdentityEmail(payload);
  } catch (err) {
    console.error(`✗ ${label} — threw: ${err.message}`);
    failures += 1;
    continue;
  }
  if (actual !== expected) {
    console.error(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  } else {
    console.log(`✓ ${label} → ${JSON.stringify(actual)}`);
  }
}

// Service-token resolution is the load-bearing assertion for the strict receipt.
const serviceTokenResolved = pickAccessIdentityEmail({ sub: '', common_name: '8dd92438f5e83adb8d85322c5b950702.access' });
if (!serviceTokenResolved) {
  console.error('✗ CRITICAL: service-token common_name did not resolve — strict-paid-pilot positive check would fail closed');
  failures += 1;
}

if (failures > 0) {
  console.error(`\n☒ verify-paid-pilot-access-identity · ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n☑ verify-paid-pilot-access-identity · all credential-type claims resolve (incl. service-token common_name)');
