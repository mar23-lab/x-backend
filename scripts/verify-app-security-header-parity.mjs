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
import {
  renderPagesHeaders,
  resolvePagesSecurityHeaderManifest,
  rewritePagesWorkerSecurityHeaders,
} from './lib/security-header-contract.mjs';

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
    const rendered = [String(o.match)];
    for (const [name, value] of Object.entries(o.headers || {})) {
      rendered.push(`  ${name}: ${value}`);
    }
    const block = rendered.join('\n');
    if (!emitted.includes(block)) out.push(`${label} missing exact override block "${block}"`);
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
const REQUIRED_MUTABLE_RUNTIME_PATHS = [
  '/',
  '/index.html',
  '/runtime-manifest.json',
  '/release-manifest.json',
  '/runtime-config.js',
  '/app-logic.js',
  '/clerk-boot.js',
  '/contract-meta.js',
  '/live-data.js',
  '/authority-consent.js',
  '/support.js',
  '/runtime-ui.css',
  '/sentry-bootstrap.js',
  '/vendor/*',
];

// (1) Manifest sanity
if (!manifest.global_headers || Object.keys(manifest.global_headers).length === 0) {
  failures.push('manifest.global_headers is empty');
}
for (const req of REQUIRED) {
  if (!manifest.global_headers?.[req]) failures.push(`manifest missing required header ${req}`);
}
for (const runtimePath of REQUIRED_MUTABLE_RUNTIME_PATHS) {
  const matches = (manifest.path_overrides || []).filter((entry) => entry.match === runtimePath);
  if (matches.length !== 1) {
    failures.push(`manifest must declare exactly one cache override for mutable runtime path ${runtimePath}`);
    continue;
  }
  if (matches[0].headers?.['Cache-Control'] !== 'no-store') {
    failures.push(`mutable runtime path ${runtimePath} must be Cache-Control: no-store`);
  }
}

// (2) Static parity against the artifact that is ACTUALLY deployed.
//
// This used to read dist-cloudflare/_headers - a directory NO script in this repo ever writes.
// fs.existsSync() was therefore always false, every artifact assertion was skipped, and the gate
// printed "PASS (static)" at exit 0 while the live deploy was missing four headers. That false
// green is the defect this block fixes: deploy-app-prod.mjs uploads dist-app-pages-release/, so
// that is the artifact to inspect, and --require-artifact makes "nothing to check" a FAILURE.
const hstsValue = manifest.global_headers?.["Strict-Transport-Security"] || "";
if (hstsValue !== 'max-age=86400') {
  failures.push(`manifest Strict-Transport-Security must be exactly "max-age=86400", got "${hstsValue}"`);
}
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

const csp = manifest.global_headers?.['Content-Security-Policy'] || '';
const scriptDirective = csp.split(';').map((part) => part.trim())
  .find((part) => part.startsWith('script-src ')) || '';
if (!csp || manifest.global_headers?.['Content-Security-Policy-Report-Only']) {
  failures.push('manifest must use enforced Content-Security-Policy, never report-only authority');
}
if (!csp.includes('report-uri /api/csp-report') || !csp.includes('report-to csp-endpoint')) {
  failures.push('manifest CSP must report to /api/csp-report through report-uri and report-to');
}
if (scriptDirective.includes("'unsafe-inline'")) {
  failures.push('manifest script-src must not contain unsafe-inline');
}
if (!scriptDirective.includes("'self'")) failures.push('manifest script-src must allow same-origin external scripts');
for (const override of manifest.path_overrides || []) {
  if (/^\/src\/widgets\/\*\.jsx$/i.test(String(override.match || ''))) {
    failures.push('legacy /src/widgets/*.jsx path override is forbidden');
  }
}

const apiMiddleware = fs.readFileSync(
  path.join(repoRoot, 'src/workers/middleware/security-headers.ts'),
  'utf8',
);
if (!apiMiddleware.includes("'Strict-Transport-Security': 'max-age=86400'")) {
  failures.push('API middleware HSTS must match the 86400-second host-only ramp');
}
if (/Strict-Transport-Security[^\n]*(includeSubDomains|preload)/i.test(apiMiddleware)) {
  failures.push('API middleware HSTS must not include includeSubDomains or preload');
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
  let artifactManifest = manifest;
  const runtimeManifestPath = path.join(dir, 'runtime-manifest.json');
  try {
    const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'));
    artifactManifest = resolvePagesSecurityHeaderManifest(manifest, runtimeManifest.api_base);
  } catch (error) {
    failures.push(`${artifactChecked} has no valid runtime API authority: ${error instanceof Error ? error.message : String(error)}`);
  }
  const emitted = fs.readFileSync(candidate, "utf8");
  failures.push(...staticParityFailures(artifactManifest, emitted, artifactChecked));
  if (emitted !== renderPagesHeaders(artifactManifest)) {
    failures.push(`${artifactChecked} is not the exact backend-manifest rendering`);
  }
  const workerPath = path.join(dir, '_worker.js', 'index.js');
  if (fs.existsSync(workerPath)) {
    const worker = fs.readFileSync(workerPath, 'utf8');
    for (const [name, value] of Object.entries(artifactManifest.global_headers || {})) {
      if (!worker.includes(String(value))) failures.push(`${workerPath} is missing effective ${name}`);
    }
    const baselineCsp = manifest.global_headers?.['Content-Security-Policy'];
    const effectiveCsp = artifactManifest.global_headers?.['Content-Security-Policy'];
    if (baselineCsp !== effectiveCsp && worker.includes(baselineCsp)) {
      failures.push(`${workerPath} retains the production CSP in a non-production artifact`);
    }
  }
  const indexPath = path.join(dir, 'index.html');
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8');
    if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
      failures.push(`${path.relative(repoRoot, indexPath)} contains an inline script`);
    }
    if (/\son(?:load|error)\s*=/i.test(html)) {
      failures.push(`${path.relative(repoRoot, indexPath)} contains an inline event handler`);
    }
  }
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
  let liveManifest = manifest;
  try {
    const runtimeResponse = await fetch(`${base}/runtime-manifest.json?cb=${Date.now()}`, { redirect: 'manual' });
    if (runtimeResponse.ok) {
      const runtimeManifest = await runtimeResponse.json();
      liveManifest = resolvePagesSecurityHeaderManifest(manifest, runtimeManifest.api_base);
    }
  } catch {
    // The root probe below remains authoritative when Access prevents reading the app manifest.
  }
  const root = await fetch(`${base}/?cb=${Date.now()}`, { redirect: 'manual' });
  if (root.status >= 300 && root.status < 400) {
    console.warn(`  note: ${base}/ returned ${root.status} (Access-gated?) - header probe may be the gate response, not the app`);
  }
  for (const [name, value] of Object.entries(liveManifest.global_headers)) {
    const got = root.headers.get(name);
    if (got !== value) failures.push(`LIVE ${name}: expected "${value}" got "${got}"`);
  }
  for (const o of liveManifest.path_overrides || []) {
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
  const good = renderPagesHeaders(manifest);
  const controls = [];
  const stagingOrigin = 'https://xlooop-api-pilot-shadow.example.workers.dev';
  const stagingManifest = resolvePagesSecurityHeaderManifest(manifest, `${stagingOrigin}/api/v1`);
  const stagingCsp = stagingManifest.global_headers['Content-Security-Policy'];
  if (!stagingCsp.includes(stagingOrigin) || stagingCsp.includes('connect-src \'self\' https://api.xlooop.com ')) {
    controls.push('staging CSP did not replace the production API origin');
  }
  try {
    resolvePagesSecurityHeaderManifest(manifest, 'http://insecure.example');
    controls.push('non-HTTPS API origin was accepted');
  } catch {
    // Expected fail-closed behavior.
  }
  const sourceCsp = manifest.global_headers['Content-Security-Policy'];
  const rewrittenFixture = rewritePagesWorkerSecurityHeaders(sourceCsp, manifest, stagingManifest);
  if (!rewrittenFixture.includes(stagingOrigin) || rewrittenFixture.includes(sourceCsp)) {
    controls.push('Pages Functions CSP rewrite did not materialize the staging origin');
  }
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
  const runtimeConfigBlock = '/runtime-config.js\n  Cache-Control: no-store';
  const cacheDriftFixture = good.replace(
    runtimeConfigBlock,
    '/runtime-config.js\n  Cache-Control: public, max-age=14400',
  );
  if (staticParityFailures(manifest, cacheDriftFixture, 'fixture').length === 0) {
    controls.push('comparator did NOT flag a cacheable mutable runtime-config.js fixture');
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
