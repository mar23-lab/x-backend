#!/usr/bin/env node
// scripts/verify-activity-ingest-contract.mjs
//
// R54-Stage3-A ci-local gate · operator/agent activity producer.
//
// The SECOND real event producer: captures non-git work (Claude/Codex/operator/
// harness) into operation_events so the cockpit reflects ALL daily work. Headline
// invariants: token-gated (no Clerk), idempotent upsert, workspace attribution
// MUST resolve (never invent one), and it must be mounted as a PUBLIC route.
//
// Structural (no live HTTP); live behaviour is exercised by the deploy smoke.
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

console.log('verify-activity-ingest-contract · R54-S3-A gate\n');

await gate('R54-S3-A: activity route exists · POST /webhooks/activity', async () => {
  const p = path.join(REPO, 'src/workers/routes/activity-webhook.ts');
  if (!existsSync(p)) return 'routes/activity-webhook.ts missing';
  const src = await fs.readFile(p, 'utf8');
  if (!/activityWebhookRoute\.post\(['"]\/webhooks\/activity['"]/.test(src)) return 'POST /webhooks/activity not defined';
  return true;
});

await gate('R54-S3-A: token-gated (constant-time) · no Clerk · 503 on missing secret · 401 on bad token', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/routes/activity-webhook.ts'), 'utf8');
  if (!/ACTIVITY_INGEST_TOKEN/.test(src)) return 'not gated on the shared ingest token';
  if (!/diff \|= token\.charCodeAt\(i\) \^ secret\.charCodeAt\(i\)/.test(src)) return 'token compare is not constant-time';
  if (!/status:\s*503/.test(src)) return 'missing-secret does not 503 (closed)';
  if (!/status:\s*401/.test(src)) return 'bad token does not 401';
  if (/clerkAuth/.test(src)) return 'must NOT use clerkAuth (token-gated public route)';
  return true;
});

await gate('R54-S3-A: per-event validation + idempotent upsert + workspace must resolve', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/routes/activity-webhook.ts'), 'utf8');
  if (!/VALID_SOURCE_TOOLS\.has\(source_tool\)/.test(src)) return 'source_tool not validated';
  if (!/dal\.upsertEvent\(workspace_id, input\)/.test(src)) return 'does not upsert via idempotent dal.upsertEvent';
  if (!/no workspace_id and no ACTIVITY_DEFAULT_WORKSPACE/.test(src)) return 'does not reject events with no resolvable workspace';
  if (!/ACTIVITY_DEFAULT_WORKSPACE \|\| ctx\.env\.GITHUB_WEBHOOK_DEFAULT_WORKSPACE/.test(src)) return 'no default-workspace resolution chain';
  return true;
});

await gate('R54-S3-A: never fabricates a past timestamp (defaults to now only when absent)', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/routes/activity-webhook.ts'), 'utf8');
  if (!/typeof e\.occurred_at === 'string' && e\.occurred_at\) \? e\.occurred_at : new Date\(\)\.toISOString\(\)/.test(src)) {
    return 'occurred_at default does not honor the caller value / now-only-when-absent';
  }
  return true;
});

await gate('R54-S3-A: mounted as a PUBLIC route in index.ts', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/index.ts'), 'utf8');
  if (!/import \{ activityWebhookRoute \}/.test(src)) return 'activityWebhookRoute not imported';
  if (!/app\.route\(['"]\/api\/v1['"], activityWebhookRoute\)/.test(src)) return 'not mounted on app (public)';
  // must be mounted at app-level (public), not inside protectedRoutes/userRoutes
  if (/protectedRoutes\.route\([^)]*activityWebhookRoute|userRoutes\.route\([^)]*activityWebhookRoute/.test(src)) {
    return 'must not be behind Clerk route groups';
  }
  return true;
});

await gate('R54-S3-A: CLI helper exists · scripts/log-activity.mjs', async () => {
  const p = path.join(REPO, 'scripts/log-activity.mjs');
  if (!existsSync(p)) return 'scripts/log-activity.mjs missing';
  const src = await fs.readFile(p, 'utf8');
  if (!/\/api\/v1\/webhooks\/activity/.test(src)) return 'CLI does not target the activity endpoint';
  if (!/XLOOOP_INGEST_TOKEN/.test(src)) return 'CLI does not read the ingest token from env';
  if (!/--dry-run/.test(src)) return 'CLI has no --dry-run';
  return true;
});

await gate('R54-S3-A: built worker bundle carries the producer', async () => {
  const p = path.join(REPO, 'dist-workers-dryrun/index.js');
  if (!existsSync(p)) return 'dry-run bundle missing — run `npm run deploy:api:dryrun`';
  const b = await fs.readFile(p, 'utf8');
  if (!b.includes('/webhooks/activity')) return 'activity route not in bundle';
  if (!b.includes('xlooop.activity_ingest_receipt.v1')) return 'activity receipt schema not in bundle';
  return true;
});

console.log(`\nverify-activity-ingest-contract · ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name} · ${f.reason}`);
  process.exit(1);
}
process.exit(0);
