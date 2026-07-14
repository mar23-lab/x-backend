#!/usr/bin/env node
// scripts/verify-github-webhook-contract.mjs
//
// R54-Stage1 ci-local gate · GitHub webhook producer (the first real event
// producer). Security-focused: the route is PUBLIC, so the HMAC gate + the
// "no DB write before signature passes" ordering + attribution-safety are
// load-bearing invariants.
//
// Structural (no live HTTP); runtime is exercised post-deploy by sending a
// signed payload + checking the cockpit.
//
// Exit 0 if all pass; 1 otherwise.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const failures = [];
async function gate(name, fn) {
  try {
    const ok = await fn();
    if (ok === true) { console.log(`  ☑ ${name}`); passed++; }
    else { console.log(`  ✗ ${name} · ${ok}`); failed++; failures.push({ name, reason: ok }); }
  } catch (e) {
    console.log(`  ✗ ${name} · threw ${e.message}`); failed++; failures.push({ name, reason: e.message });
  }
}

console.log('verify-github-webhook-contract · R54-S1 gate\n');
const ROUTE = path.join(REPO, 'src/workers/routes/github-webhook.ts');

await gate('R54-S1: webhook route exists + mounted PUBLIC (pre-clerkAuth) in index.ts', async () => {
  if (!existsSync(ROUTE)) return 'route file missing';
  const idx = await fs.readFile(path.join(REPO, 'src/workers/index.ts'), 'utf8');
  if (!/githubWebhookRoute/.test(idx)) return 'not imported/mounted in index.ts';
  // must be mounted in the public block (before protectedRoutes/clerkAuth)
  const mountIdx = idx.indexOf("app.route('/api/v1', githubWebhookRoute)");
  const protectedIdx = idx.indexOf('protectedRoutes.use');
  if (mountIdx < 0) return 'githubWebhookRoute not mounted';
  if (protectedIdx > 0 && mountIdx > protectedIdx) return 'webhook mounted AFTER clerkAuth — would 401 GitHub';
  return true;
});

await gate('R54-S1: HMAC-SHA256 signature verification (constant-time, sha256= prefix)', async () => {
  const src = await fs.readFile(ROUTE, 'utf8');
  if (!/verifyGithubSignature/.test(src)) return 'no verifyGithubSignature';
  if (!/crypto\.subtle\.(importKey|sign)/.test(src)) return 'does not use Web Crypto HMAC';
  if (!/X-Hub-Signature-256/.test(src)) return 'does not read X-Hub-Signature-256';
  if (!/startsWith\('sha256='\)/.test(src)) return 'does not require sha256= prefix';
  if (!/diff \|= /.test(src)) return 'compare is not constant-time (xor-accumulate)';
  return true;
});

await gate('R54-S1 · SECURITY: no DB write before signature passes; missing secret → 503; bad sig → 401', async () => {
  const src = await fs.readFile(ROUTE, 'utf8');
  // the upsert must occur AFTER the signature check
  const sigIdx = src.indexOf('verifyGithubSignature(secret');
  const upsertIdx = src.indexOf('dal.upsertEvent');
  if (sigIdx < 0 || upsertIdx < 0) return 'cannot locate sig check or upsert';
  if (upsertIdx < sigIdx) return 'DB upsert appears BEFORE the signature check (LEAK/abuse risk)';
  if (!/ctx\.status\(503\)/.test(src) || !/GITHUB_WEBHOOK_SECRET not configured/.test(src)) return 'missing-secret does not 503';
  if (!/ctx\.status\(401\)/.test(src)) return 'bad signature does not 401';
  return true;
});

await gate('R54-S1 · ATTRIBUTION-SAFE: workspace resolved from env, NEVER from payload', async () => {
  const src = await fs.readFile(ROUTE, 'utf8');
  if (!/GITHUB_WEBHOOK_REPO_MAP|GITHUB_WEBHOOK_DEFAULT_WORKSPACE/.test(src)) return 'no env-based attribution';
  // resolveAttribution's ONLY inputs are env + the repo-name string (a lookup
  // key), never the raw payload object. Assert the signature + env derivation,
  // and that the function body (up to its first closing brace) has no `payload`.
  const start = src.indexOf('function resolveAttribution');
  if (start < 0) return 'resolveAttribution not found';
  if (!/function resolveAttribution\(env: GithubWebhookEnv, fullName: string\)/.test(src)) {
    return 'resolveAttribution signature must be (env, fullName: string) — no payload object';
  }
  const body = src.slice(start, src.indexOf('\n}', start) + 2); // just the function body
  if (/\bpayload\b/.test(body)) return 'resolveAttribution body references payload — workspace must come from env only';
  if (!/env\.GITHUB_WEBHOOK_REPO_MAP/.test(body) || !/env\.GITHUB_WEBHOOK_DEFAULT_WORKSPACE/.test(body)) {
    return 'workspace not derived from env';
  }
  if (!/return null/.test(body)) return 'no safe drop when repo is unmapped (must not guess a workspace)';
  // and the caller must drop (record nothing) when attribution is null
  if (!/no_attribution_for_repo/.test(src)) return 'caller does not safely drop unattributed events';
  return true;
});

await gate('R54-S1: idempotent event ids (gh_commit_/gh_pull_/gh_issue_) + ping → 200', async () => {
  const src = await fs.readFile(ROUTE, 'utf8');
  if (!/gh_commit_|gh_pull_|gh_issue_/.test(src)) return 'event ids are not stable/prefixed (idempotency risk)';
  if (!/eventType === 'ping'/.test(src)) return 'does not handle GitHub ping';
  return true;
});

await gate('R54-S1: built worker bundle carries the route + HMAC', async () => {
  const p = path.join(REPO, 'dist-workers-dryrun/index.js');
  if (!existsSync(p)) return 'dry-run bundle missing — run `npm run deploy:api:dryrun`';
  const b = await fs.readFile(p, 'utf8');
  if (!b.includes('/webhooks/github')) return 'route not in bundle';
  if (!b.includes('X-Hub-Signature-256')) return 'HMAC not in bundle';
  return true;
});

console.log(`\nverify-github-webhook-contract · ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name} · ${f.reason}`);
  process.exit(1);
}
process.exit(0);
