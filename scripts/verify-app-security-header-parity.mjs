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

const requireArtifact = args.includes("--require-artifact");
const selfTest = args.includes("--self-test");

// Pure comparator, extracted so --self-test can prove it actually detects drift.
function staticParityFailures(manifestObject, emitted, label) {
  const out = [];
  for (const [name, value] of Object.entries(manifestObject.global_headers || {})) {
    if (!emitted.includes(`${name}: ${value}`)) out.push(`${label} missing "${name}: ${value}"`);
  }
  for (const o of manifestObject.path_overrides || []) {
    if (!emitted.includes(o.match)) out.push(`${label} missing path "${o.match}"`);
  }
  return out;
}

const failures = [];
const REQUIRED = [
  "X-Content-Type-Options",
  "Referrer-Policy",
  "X-Frame-Options",
  "Strict-Transport-Security",
  "Permissions-Policy",
  "Reporting-Endpoints",
];

// (1) Manifest sanity
if (!manifest.global_headers || Object.keys(manifest.global_headers).length === 0) {
  failures.push('manifest.global_headers is empty');
}
for (const req of REQUIRED) {
  if (!manifest.global_headers?.[req]) failures.push(`manifest missing required header ${req}`);
}

// (2) Static parity against the artifact that is ACTUALLY deployed.
//
// This used to read dist-cloudflare/_headers - a directory NO script in this repo ever writes.
// fs.existsSync() was therefore always false, every artifact assertion was skipped, and the gate
// printed "PASS (static)" at exit 0 while the live deploy was missing four headers. That false
// green is the defect this block fixes: deploy-app-prod.mjs uploads dist-app-pages-release/, so
// that is the artifact to inspect, and --require-artifact makes "nothing to check" a FAILURE.
const hstsValue = manifest.global_headers?.["Strict-Transport-Security"] || "";
if (hstsValue.includes("preload")) {
  failures.push(
    `manifest Strict-Transport-Security contains "preload" - preload is effectively irreversible `
    + `for about 2 years and, once advertised, any third party may submit the domain to the browser `
    + `preload list. Ramping it is a deliberate operator decision, not a side effect.`,
  );
}
if (hstsValue.includes("includeSubDomains")) {
  failures.push(
    `manifest Strict-Transport-Security contains "includeSubDomains" - this forces HTTPS on every `
    + `*.xlooop.com host, including per-tenant hosts. Adding it requires auditing every subdomain first.`,
  );
}

const ARTIFACT_CANDIDATES = [
  process.env.XLOOOP_APP_PAGES_RELEASE_DIR || "",
  path.join(repoRoot, "dist-app-pages-release"),
  path.join(repoRoot, "dist-cloudflare"),
].filter(Boolean);

let artifactChecked = null;
for (const dir of ARTIFACT_CANDIDATES) {
  const candidate = path.join(dir, "_headers");
  if (!fs.existsSync(candidate)) continue;
  artifactChecked = path.relative(repoRoot, candidate) || candidate;
  failures.push(...staticParityFailures(manifest, fs.readFileSync(candidate, "utf8"), artifactChecked));
  break;
}
if (!artifactChecked && requireArtifact) {
  failures.push(
    `no built _headers artifact found (looked in: ${ARTIFACT_CANDIDATES.join(", ")}) - build the `
    + `release before running with --require-artifact`,
  );
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

if (selfTest) {
  // Control: prove the comparator FAILS on drift. A gate that cannot fail is not a gate.
  const good = "/*\n"
    + Object.entries(manifest.global_headers).map(([hk, hv]) => `  ${hk}: ${hv}`).join("\n")
    + "\n"
    + (manifest.path_overrides || []).map((o) => o.match).join("\n")
    + "\n";
  const controls = [];
  if (staticParityFailures(manifest, good, "fixture").length !== 0) {
    controls.push("comparator flagged a COMPLIANT fixture (false positive)");
  }
  const firstHeader = Object.keys(manifest.global_headers)[0];
  const firstValue = manifest.global_headers[firstHeader];
  const missingFixture = good
    .split("\n")
    .filter((l) => !l.trim().startsWith(`${firstHeader}:`))
    .join("\n");
  if (staticParityFailures(manifest, missingFixture, "fixture").length === 0) {
    controls.push(`comparator did NOT flag a fixture missing ${firstHeader}`);
  }
  const driftedFixture = good.replace(firstValue, "TAMPERED");
  if (staticParityFailures(manifest, driftedFixture, "fixture").length === 0) {
    controls.push(`comparator did NOT flag a DRIFTED ${firstHeader}`);
  }
  if (controls.length) {
    console.error("verify-app-security-header-parity --self-test FAIL");
    for (const c of controls) console.error(`  x ${c}`);
    process.exit(1);
  }
  console.log("verify-app-security-header-parity - self-test PASS (comparator detects missing and drifted headers)");
}

if (failures.length) {
  console.error('verify-app-security-header-parity · FAIL');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  `verify-app-security-header-parity - PASS ${
    liveUrl
      ? `(live: ${liveUrl})`
      : artifactChecked
        ? `(artifact: ${artifactChecked})`
        : "(manifest only - no built artifact; use --require-artifact to make that a failure)"
  }`,
);
