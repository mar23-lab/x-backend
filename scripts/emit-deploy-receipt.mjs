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

const health = await (async () => {
  const res = await fetch(`${apiBase}/api/v1/health?cb=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`/health ${res.status}`);
  return res.json();
})();

if (String(health.build || '') !== head) {
  console.error(`✗ REFUSED: deployed build ${health.build} != local HEAD ${head} — no receipt written for a mismatched deploy. Deploy first, or run from the deployed commit.`);
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
