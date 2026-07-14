#!/usr/bin/env node
// verify-app-security-header-parity.mjs · F2 enforcement.
//
// Asserts the app-plane security headers stay in lockstep across:
//   (1) the SSOT manifest         data/security-headers.manifest.json
//   (2) the generated static file dist-cloudflare/_headers (if built)
//   (3) the LIVE deploy           (when --live <url> is passed)
//
// The live check is the teeth: a prod deploy whose served headers drift from the manifest
// FAILS this gate. Usage:
//   node scripts/verify-app-security-header-parity.mjs                 # static (manifest + _headers)
//   node scripts/verify-app-security-header-parity.mjs --live https://app.xlooop.com
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'data/security-headers.manifest.json'), 'utf8'),
);

const args = process.argv.slice(2);
let liveUrl = null;
const eq = args.find((a) => a.startsWith('--live='));
if (eq) liveUrl = eq.slice('--live='.length);
else if (args.includes('--live')) liveUrl = args[args.indexOf('--live') + 1];

const failures = [];
const REQUIRED = ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options'];

// (1) Manifest sanity
if (!manifest.global_headers || Object.keys(manifest.global_headers).length === 0) {
  failures.push('manifest.global_headers is empty');
}
for (const req of REQUIRED) {
  if (!manifest.global_headers?.[req]) failures.push(`manifest missing required header ${req}`);
}

// (2) Static _headers parity (if dist-cloudflare was built)
const headersFile = path.join(repoRoot, 'dist-cloudflare', '_headers');
if (fs.existsSync(headersFile)) {
  const emitted = fs.readFileSync(headersFile, 'utf8');
  for (const [name, value] of Object.entries(manifest.global_headers)) {
    if (!emitted.includes(`${name}: ${value}`)) {
      failures.push(`dist-cloudflare/_headers missing "${name}: ${value}"`);
    }
  }
  for (const o of manifest.path_overrides || []) {
    if (!emitted.includes(o.match)) failures.push(`dist-cloudflare/_headers missing path "${o.match}"`);
  }
}

// (3) Live parity (the real F2 gate)
function mimeEq(got, want) {
  // tolerate platform charset normalisation for Content-Type
  if (!got) return false;
  return got.split(';')[0].trim() === want.split(';')[0].trim();
}
if (liveUrl) {
  const base = liveUrl.replace(/\/$/, '');
  const root = await fetch(`${base}/?cb=${Date.now()}`, { redirect: 'manual' });
  if (root.status >= 300 && root.status < 400) {
    console.warn(`  note: ${base}/ returned ${root.status} (Access-gated?) - header probe may be the gate response, not the app`);
  }
  for (const [name, value] of Object.entries(manifest.global_headers)) {
    const got = root.headers.get(name);
    if (got !== value) failures.push(`LIVE ${name}: expected "${value}" got "${got}"`);
  }
  for (const o of manifest.path_overrides || []) {
    const probePath = o.match.replace('*', 'R51CockpitMount/R51CockpitMount');
    const pr = await fetch(`${base}${probePath}?cb=${Date.now()}`, { redirect: 'manual' });
    for (const [name, value] of Object.entries(o.headers)) {
      const got = pr.headers.get(name);
      const ok = name.toLowerCase() === 'content-type' ? mimeEq(got, value) : got === value;
      if (!ok) failures.push(`LIVE ${probePath} ${name}: expected "${value}" got "${got}"`);
    }
  }
}

if (failures.length) {
  console.error('verify-app-security-header-parity · FAIL');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`verify-app-security-header-parity · PASS ${liveUrl ? `(live: ${liveUrl})` : '(static)'}`);
