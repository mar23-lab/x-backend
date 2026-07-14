#!/usr/bin/env node
// verify-no-raw-operation-events-insert.mjs · P4 (260629) · BLOCKING source-scan gate.
//
// Guards the silent-audit-loss failure class found 260629: documents.ts emitted operation_events via a bespoke
// raw `INSERT ... operation_events` in a lib/ helper (document-store.insertDocumentEventRow) that BYPASSED the
// typed canonical path (dal/event-store.upsertEventRow, whose source_tool is a compile-checked SourceTool). It
// used an unregistered source_tool ('document-upload') that failed the CHECK and was swallowed best-effort, so
// the governed audit event silently never landed. Prevention > detection (260628 retro doctrine): forbid any
// raw governed-event INSERT outside the canonical DAL stores, so every operation_events write goes through the
// typed, validated seam where an invalid source_tool is a COMPILE error.
//
// Rule (deterministic): a runtime .ts under src/workers/ (excluding *.test.ts) may NOT contain
// `INSERT <...> INTO operation_events` unless it is an allow-listed canonical DAL store. `--self-test` proves
// the gate CATCHES a new bypass, PASSES the real tree, and does NOT trip on a SELECT.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/workers';
// Match a real INSERT statement targeting operation_events (tolerates a column list before the table name only
// via the canonical `INSERT INTO operation_events`). Anchored on the INSERT verb so comments/SELECTs don't match.
const NEEDLE = /INSERT\s+INTO\s+operation_events\b/i;

// Canonical homes that legitimately own operation_events SQL (the DAL data-access layer). Everything else must
// route through dal/event-store.upsertEventRow.
const ALLOWLIST = new Set([
  'src/workers/dal/event-store.ts',                 // THE canonical typed upsertEventRow
  'src/workers/dal/intent-store.ts',                // intent-lifecycle events (DAL)
  'src/workers/dal/customer-provisioning-store.ts', // provisioning seed events (DAL)
  // W1 (260708) · spine unification: createToolEventRow emits the companion 'tool_action' event in the SAME
  // RLS transaction as the tool_events INSERT (atomicity — upsertEventRow is not transaction-composable).
  // The source_tool is the compile-checked TOOL_ACTION_SOURCE: SourceTool constant, preserving exactly the
  // typed-seam property this gate exists for.
  'src/workers/dal/operational-spine-store.ts',
]);

function tsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === '__tests__' || e === 'node_modules') continue;
      out.push(...tsFiles(p));
    } else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

function findViolations() {
  const violations = [];
  for (const f of tsFiles(ROOT)) {
    const rel = f.replace(/\\/g, '/');
    if (ALLOWLIST.has(rel)) continue;
    if (NEEDLE.test(readFileSync(f, 'utf8'))) violations.push(rel);
  }
  return violations;
}

if (process.argv.includes('--self-test')) {
  const real = findViolations();
  const catches = NEEDLE.test('await sql`INSERT INTO operation_events (id) VALUES (${x})`');
  const ignoresSelect = NEEDLE.test('SELECT id FROM operation_events WHERE workspace_id = ${ws}') === false;
  const ok = real.length === 0 && catches === true && ignoresSelect === true;
  if (!ok) {
    console.error('✗ verify:no-raw-operation-events-insert self-test FAILED', { realViolations: real, catches, ignoresSelect });
    process.exit(1);
  }
  console.log('✓ self-test PASSED · real tree clean · catches a raw INSERT · ignores SELECT');
  process.exit(0);
}

const violations = findViolations();
if (violations.length > 0) {
  console.error('✗ raw governed-event INSERT outside the canonical DAL stores:');
  for (const v of violations) console.error('   ' + v);
  console.error('  → route governed events through dal/event-store.upsertEventRow (typed source_tool: SourceTool), not a raw INSERT.');
  process.exit(1);
}
console.log(`✓ no raw operation_events INSERT outside the ${ALLOWLIST.size} allow-listed canonical DAL stores`);
process.exit(0);
