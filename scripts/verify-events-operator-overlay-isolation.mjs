#!/usr/bin/env node
// scripts/verify-events-operator-overlay-isolation.mjs
//
// R54-Stage2 ci-local gate · operator-overlay on GET /api/v1/events.
//
// Makes the cockpit chat show the operator's REAL activity: the operator's
// events live across their orgs (org_3EG82…), not their JWT workspace, so for
// the verified owner we list across the operator identity set. The headline
// invariant is TENANT ISOLATION — non-operators must keep the strict
// workspace-scoped path, and the overlay must scope to operator-owned
// workspaces only (the APS-leak failure mode).
//
// Structural (no live HTTP); the live no-leak behaviour was verified against
// prod Neon during the build (7 events, all from org_3EG82, zero other ws).
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

console.log('verify-events-operator-overlay-isolation · R54-S2 gate\n');

await gate('R54-S2: DalAdapter declares listEventsForOperator(ownerUserIds[])', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/dal/DalAdapter.ts'), 'utf8');
  if (!/listEventsForOperator\(\s*ownerUserIds: string\[\]/.test(src)) return 'signature missing or not an id-set';
  return true;
});

await gate('R54-S2 · TENANT GUARD: impl scopes events to operator-owned workspaces ONLY', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/dal/WorkersDalAdapter.ts'), 'utf8');
  const start = src.indexOf('async listEventsForOperator');
  if (start < 0) return 'impl missing';
  const end = src.indexOf('// POST /api/v1/events (idempotent upsert)', start);
  const fn = src.slice(start, end > start ? end : start + 4000);
  if (!/SELECT id FROM workspaces WHERE owner_user_id = ANY\(\$\{ids\}\)/.test(fn)) {
    return 'does not derive workspaces from the owner-id set';
  }
  const reads = fn.match(/FROM operation_events/g) || [];
  if (reads.length !== 1) return `expected exactly 1 operation_events read, found ${reads.length}`;
  if (!/FROM operation_events\s+WHERE workspace_id = ANY\(\$\{wsIds\}\)/.test(fn)) {
    return 'the operation_events read is NOT scoped to operator workspaces (LEAK RISK)';
  }
  return true;
});

await gate('R54-S2: route uses overlay for the VERIFIED owner only; non-operators keep strict path', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/routes/events.ts'), 'utf8');
  const h = src.slice(src.indexOf("eventsRoute.get('/events'"));
  if (!/MBP_OWNER_USER_ID/.test(h)) return 'overlay not gated on MBP_OWNER_USER_ID';
  if (!/user_id === ownerUserId/.test(h)) return 'overlay not gated on requester == owner';
  if (!/listEventsForOperator/.test(h)) return 'route does not call the overlay DAL method';
  if (!/dal\.listEvents\(workspace_id, opts\)/.test(h)) return 'strict workspace-scoped path was removed for non-operators';
  return true;
});

await gate('R54-S2c: events route mounted org-OPTIONAL (overlay reachable from a personal session)', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/index.ts'), 'utf8');
  // The events route must be in a requireOrg:false group, NOT the requireOrg-true
  // protectedRoutes group (else an orgless operator is 403'd before the overlay).
  if (!/const eventsRoutes = new Hono[\s\S]*?eventsRoutes\.use\('\*', clerkAuth\(\{ requireOrg: false \}\)\)[\s\S]*?eventsRoutes\.route\('\/', eventsRoute\)/.test(src)) {
    return 'eventsRoute is not mounted in a requireOrg:false group';
  }
  // It must NOT also be mounted under protectedRoutes (the org-required group).
  if (/protectedRoutes\.route\('\/', eventsRoute\)/.test(src)) {
    return 'eventsRoute still mounted under requireOrg-true protectedRoutes (orgless operator would 403)';
  }
  return true;
});

await gate('R54-S2c · CUSTOMER ISOLATION: non-operator paths re-assert org_id in-handler', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/routes/events.ts'), 'utf8');
  // GET strict path: the non-operator branch must 403 when workspace_id is empty,
  // immediately before the dal.listEvents() call (was enforced by middleware).
  const get = src.slice(src.indexOf("eventsRoute.get('/events'"), src.indexOf("eventsRoute.post('/events'"));
  if (!/if \(!workspace_id\) \{[\s\S]*?ctx\.status\(403\)[\s\S]*?\}\s*\n\s*const page = await dal\.listEvents\(workspace_id, opts\)/.test(get)) {
    return 'GET non-operator path does not 403 on empty workspace_id (orgless cross-tenant risk)';
  }
  // POST: must 403 on empty workspace_id (ingestion is workspace-scoped).
  const post = src.slice(src.indexOf("eventsRoute.post('/events'"));
  if (!/if \(!workspace_id\) \{[\s\S]*?ctx\.status\(403\)/.test(post)) {
    return 'POST does not 403 on empty workspace_id (orgless ingestion)';
  }
  return true;
});

await gate('R54-S2: built worker bundle carries the overlay', async () => {
  const p = path.join(REPO, 'dist-workers-dryrun/index.js');
  if (!existsSync(p)) return 'dry-run bundle missing — run `npm run deploy:api:dryrun`';
  const b = await fs.readFile(p, 'utf8');
  if (!b.includes('listEventsForOperator')) return 'overlay not in bundle';
  return true;
});

console.log(`\nverify-events-operator-overlay-isolation · ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name} · ${f.reason}`);
  process.exit(1);
}
process.exit(0);
