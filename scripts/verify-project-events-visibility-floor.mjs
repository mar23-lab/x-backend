#!/usr/bin/env node
// verify-project-events-visibility-floor.mjs · F17 fix (260707) · per-project events visibility gate.
//
// WHY: GET /api/v1/projects/:id/events → listEventsForProjectScopeRow historically applied NO role-based
// visibility tier floor and NO archived_at filter, so a viewer-role member received internal_owner_only +
// soft-deleted events the flat GET /events correctly withholds (same-workspace, but a real visibility-tier
// breach — and A-W2e stamped that very response withDataClass('live')+withAuthority). This gate freezes the
// fix: EVERY `SELECT … FROM operation_events` inside listEventsForProjectScopeRow must carry both the tier
// floor (`visibility = ANY(...)`, from visibilityForRole(opts.role)) and `archived_at IS NULL`.
//
// Adversarial: delete either filter from any of the 3 query branches (no-binding / combine-any / combine-all)
// → FAIL. Prevention > detection.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = 'src/workers/dal/event-store.ts';
const fail = [];

const src = fs.readFileSync(path.join(ROOT, STORE), 'utf8');

// Isolate the function body (from its declaration to the next top-level `export ` / EOF).
const startIdx = src.indexOf('export async function listEventsForProjectScopeRow');
if (startIdx === -1) {
  fail.push(`${STORE} · listEventsForProjectScopeRow not found`);
} else {
  const after = src.slice(startIdx + 1);
  const nextExport = after.indexOf('\nexport ');
  const body = nextExport === -1 ? after : after.slice(0, nextExport);

  // The tier floor must be computed from the caller's role.
  if (!/visibilityForRole\(opts\.role\)/.test(body)) {
    fail.push(`${STORE} · listEventsForProjectScopeRow no longer derives the visibility tier floor from opts.role (visibilityForRole)`);
  }

  // Every SELECT … FROM operation_events block must carry BOTH filters. Split on the operation_events
  // reads and inspect each block up to its ORDER BY.
  const blocks = body.split(/FROM operation_events/).slice(1);
  if (blocks.length < 3) {
    fail.push(`${STORE} · expected ≥3 operation_events query branches in listEventsForProjectScopeRow, found ${blocks.length} — did the query shape change without re-verifying the floor?`);
  }
  blocks.forEach((b, i) => {
    const clause = b.split(/ORDER BY/)[0]; // the WHERE region of this branch
    if (!/archived_at IS NULL/.test(clause)) {
      fail.push(`${STORE} · project-events query branch #${i + 1} is missing 'archived_at IS NULL' — soft-deleted rows leak to the per-project read`);
    }
    if (!/visibility = ANY\(\$\{visList/.test(clause)) {
      fail.push(`${STORE} · project-events query branch #${i + 1} is missing the tier floor 'visibility = ANY(\${visList…})' — a viewer can receive internal_owner_only rows`);
    }
  });
}

if (fail.length) {
  console.error('✗ project-events-visibility-floor · FAIL — per-project event visibility tiering regressed:');
  for (const v of fail) console.error(`    ${v}`);
  console.error('  GET /projects/:id/events must apply the same visibility tier floor + archived filter as GET /events.');
  process.exit(1);
}

console.log('☑ project-events-visibility-floor · PASS · all listEventsForProjectScopeRow branches apply the tier floor + archived filter');
process.exit(0);
