#!/usr/bin/env node
// scripts/emit-deploy-receipt.mjs · 260710-F M3 — the deploy-receipt EMITTER.
//
// Kills the stale-receipt failure class (the receipt sat at 8407fb6c while prod ran bc59a16f —
// hand-written receipts drift). F13-HONEST: this emitter REFUSES to write a receipt unless the
// live /health readback build MATCHES the local HEAD short SHA — it can never document a deploy
// that didn't happen. Run it AFTER deploy:api + your own verification:
//
//   npm run deploy:api           # operator-gated
//   npm run deploy:api:receipt   # this script — verify + emit
//
// Deliberately NOT auto-chained into deploy:api (deploys are operator-gated; the receipt is the
// post-verify step). Preserves the receipt's `observability` block verbatim (the Sentry incident
// history is load-bearing provenance).
//
// Options: --api <base> (default https://api.xlooop.com) · --receipt <path> · --dry-run

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flagVal = (n) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const dryRun = args.includes('--dry-run');
const apiBase = flagVal('--api') || 'https://api.xlooop.com';
const receiptPath = flagVal('--receipt') || path.join(ROOT, 'docs/deployment/evidence/cloudflare-api-deploy-receipt.json');

const head = execSync('git rev-parse --short=8 HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
const headFull = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();

// 260727 REPAIR — two defects found while chaining this script into deploy:api.
//
// (1) STAMP-FORMAT SKEW. Commit 41dc88b (0722) restored the provenance stamp as the FULL 40-char
//     `git rev-parse HEAD`; this script still compared it against `--short=8`. A 40-char build can
//     never equal an 8-char head, so the comparison had become unconditionally false — this script
//     would have REFUSED every correct deploy. It was invisible because the script was not chained
//     into deploy:api, so the breakage had no consumer. Compare on a normalised prefix instead, so
//     both the current full stamp and any legacy short stamp verify correctly.
//
// (2) NO PROPAGATION WINDOW. A single-shot read races Cloudflare's edge: a /health readback taken
//     immediately after `wrangler deploy` returns the PREVIOUS build for ~10-25s. Chaining a
//     single-shot check would have produced a flaky gate that fails correct deploys — the same
//     misread that nearly caused a false "rollback is broken" verdict on 260717. `--wait <seconds>`
//     polls until the build matches (the demo's chained call used `--wait 120`).
const waitSecs = Number(flagVal('--wait') || 0);

/** True when the live build and local HEAD are the same commit, whichever sha width each uses. */
const buildMatchesHead = (build) => {
  const b = String(build || '').trim();
  if (!b) return false;
  const n = Math.min(b.length, headFull.length);
  return n >= 8 && b.slice(0, n) === headFull.slice(0, n);
};

const fetchHealth = async () => {
  const res = await fetch(`${apiBase}/api/v1/health?cb=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`/health ${res.status}`);
  return res.json();
};

let health = await fetchHealth();
if (!buildMatchesHead(health.build) && waitSecs > 0) {
  const deadline = Date.now() + waitSecs * 1000;
  process.stdout.write(`… waiting up to ${waitSecs}s for /health to report ${head} (edge propagation)`);
  while (Date.now() < deadline && !buildMatchesHead(health.build)) {
    await new Promise((r) => setTimeout(r, 5000));
    process.stdout.write('.');
    try { health = await fetchHealth(); } catch { /* transient during rollout; keep polling until deadline */ }
  }
  process.stdout.write('\n');
}

if (!buildMatchesHead(health.build)) {
  console.error(`✗ REFUSED: deployed build ${health.build} != local HEAD ${headFull.slice(0, 12)} — no receipt written for a mismatched deploy. Deploy first, or run from the deployed commit.`);
  if (waitSecs > 0) console.error(`  (waited ${waitSecs}s for propagation; the live build never became this commit)`);
  process.exit(1);
}

// Smoke: an authed route must still 401 (tenant boundary), health already 200.
const authed = await fetch(`${apiBase}/api/v1/workspaces`, { redirect: 'manual' });
const authedOk = authed.status === 401;

const prior = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : {};
const receipt = {
  surface: prior.surface || 'api.xlooop.com (Cloudflare Worker: xlooop-api)',
  commit: head,
  build_sha: head,
  built_at: String(health.built_at || ''),
  deploy_note: `emitted ${new Date().toISOString()} by scripts/emit-deploy-receipt.mjs after live /health readback match`,
  health_readback: { status: String(health.status || ''), version: String(health.version || ''), build: String(health.build || '') },
  observability: prior.observability || { sentry_active: !!health.sentry_active },
  zero_5xx_smoke: authedOk ? 'health 200; authed routes 401; no 5xx' : `WARNING: authed route returned ${authed.status} (expected 401) — investigate before trusting`,
  provenance: 'emitted by scripts/emit-deploy-receipt.mjs (refuses on build/HEAD mismatch — F13-honest)',
};

if (dryRun) {
  console.log(`DRY-RUN · HEAD ${head} == deployed ${health.build} · authed 401=${authedOk}`);
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(0);
}
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`☑ receipt emitted · ${path.relative(ROOT, receiptPath)} · build ${head} (readback-verified)${authedOk ? '' : ' · WITH SMOKE WARNING'}`);
