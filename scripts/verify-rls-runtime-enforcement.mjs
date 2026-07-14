#!/usr/bin/env node
// verify-rls-runtime-enforcement.mjs · A-W3 · RLS runtime-routing freeze (260707).
//
// WHY: tenancy defense-in-depth is only REAL at runtime if the customer-facing reads of RLS-policy tables
// go through the NON-OWNER client (`this.rlsSql`, provisioned from XLOOOP_RLS_APP_DATABASE_URL). The owner
// client (`this.sql`) BYPASSES RLS (owner + NOBYPASSRLS is false, and policies are not FORCED). The routing
// is correct today (getEvent/getProject/listProjects/… all use this.rlsSql — 043/045/047 cutovers) but
// UNGATED: a refactor that flips one `this.rlsSql` → `this.sql` would silently disable the DB tenancy layer
// for that read with NO test failing. This gate freezes it. Prevention > detection.
//
// THE RULE: in WorkersDalAdapter, each customer-facing RLS-table read must call its Row function with
// `this.rlsSql`, never `this.sql`. Operator-overlay reads (…ForOperatorRow — deliberately multi-workspace,
// `workspace_id = ANY(owned)`, which a single-value GUC cannot express) correctly use `this.sql` and are
// EXEMPT. Also asserts the bootstrap wires rlsSql from XLOOOP_RLS_APP_DATABASE_URL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = 'src/workers/dal/WorkersDalAdapter.ts';
const INDEX = 'src/workers/index.ts';

// Row functions that read customer-owned RLS-policy tables — each MUST be called with this.rlsSql.
// (Grounded 260707 from migrations 043/045/047 + the RLS policy set on prod.)
const RLS_READS = [
  'listEventsRow', 'getEventRow',                 // operation_events (043)
  'listProjectsRow', 'getProjectRow', 'listChildProjectsRow', // projects (045)
  'listProjectSourceBindingsRow',                 // project_source_bindings (047)
  'listBoardCardsRow',                            // board_cards (047)
];

const violations = [];

const adapterAbs = path.join(ROOT, ADAPTER);
if (!fs.existsSync(adapterAbs)) {
  violations.push(`${ADAPTER} · adapter not found`);
} else {
  const src = fs.readFileSync(adapterAbs, 'utf8');
  for (const fn of RLS_READS) {
    // Every call to this Row fn inside the adapter must pass this.rlsSql as the FIRST arg.
    const callRe = new RegExp(`\\b${fn}\\s*\\(\\s*this\\.(rlsSql|sql)\\b`, 'g');
    const calls = [...src.matchAll(callRe)];
    if (calls.length === 0) {
      violations.push(`${ADAPTER} · ${fn} — no call site found (renamed/removed?)`);
      continue;
    }
    for (const m of calls) {
      if (m[1] !== 'rlsSql') {
        const line = src.slice(0, m.index).split('\n').length;
        violations.push(`${ADAPTER}:${line} · ${fn}(this.${m[1]}, …) — customer RLS read must use this.rlsSql (owner client bypasses RLS)`);
      }
    }
  }
}

// Bootstrap must provision rlsSql from the non-owner DSN (else rlsSql defaults to owner and RLS is inert).
const indexAbs = path.join(ROOT, INDEX);
if (!fs.existsSync(indexAbs)) {
  violations.push(`${INDEX} · not found`);
} else {
  const idx = fs.readFileSync(indexAbs, 'utf8');
  if (!/XLOOOP_RLS_APP_DATABASE_URL\s*\?\s*neonClient/.test(idx)) {
    violations.push(`${INDEX} · rlsSql not provisioned from XLOOOP_RLS_APP_DATABASE_URL (RLS-subject client not wired)`);
  }
  if (!/new WorkersDalAdapter\(\s*sql\s*,\s*rlsSql\s*\)/.test(idx)) {
    violations.push(`${INDEX} · WorkersDalAdapter not constructed with (sql, rlsSql) — the RLS-subject client is not passed`);
  }
}

if (violations.length) {
  console.error('✗ rls-runtime-enforcement · FAIL — a customer RLS read would bypass the DB tenancy layer:');
  for (const v of violations) console.error(`    ${v}`);
  console.error('  Customer reads of RLS tables must use this.rlsSql (see migrations 043/045/047). Operator-overlay (…ForOperator) reads are exempt.');
  process.exit(1);
}

console.log(`☑ rls-runtime-enforcement · PASS · ${RLS_READS.length} customer RLS reads on this.rlsSql · rlsSql wired from XLOOOP_RLS_APP_DATABASE_URL`);
process.exit(0);
