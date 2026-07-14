#!/usr/bin/env node
// verify-no-hard-delete-customer-tables.mjs · customer-recoverability regression gate (260706).
//
// WHY: migration 044 converted the last live hard-deletes of customer-owned work to soft-delete, so
// no agent/API call can PERMANENTLY destroy a customer's work. This gate freezes that guarantee: it
// FAILS if any store/route introduces a live `DELETE FROM <customer-table>`.
//
// THE RULE (semantic, not a blanket ban): you may only HARD-delete a customer row that is ALREADY
// soft-deleted — i.e. a retention purge. So a `DELETE FROM <protected>` is allowed ONLY when its own
// statement is guarded by `archived_at IS NOT NULL` or `deleted_at IS NOT NULL` (it targets rows the
// customer already soft-deleted, past the restore window). Any unguarded live DELETE = a permanent
// data-loss path = FAIL. This lets legitimate purge crons through while blocking the footgun.
//
// Prevention > detection (session doctrine): this is the lesson-to-gate for the hard-delete class.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Customer-owned tables where a live hard-delete = irrecoverable loss of a customer's work.
const PROTECTED = new Set([
  'operation_events', 'projects', 'workspaces', 'documents', 'decisions', 'intents',
  'board_cards', 'chat_threads', 'chat_messages', 'project_source_bindings', 'source_repos',
  'user_source_connections', 'folder_snapshots', 'synthetic_domain_roadmap_items', 'prompt_tags',
  'customer_api_tokens', 'customer_authority_consents', 'customer_entitlements',
  'readiness_assessments', 'sign_offs', 'workspace_members',
]);

const SCAN_DIRS = ['src/workers/dal', 'src/workers/routes'];
const DELETE_RE = /DELETE\s+FROM\s+([a-z_][a-z0-9_]*)/gi;
// A DELETE is an allowed retention purge only if the SAME statement guards on a soft-delete marker.
const PURGE_GUARD_RE = /(archived_at|deleted_at|disconnected_at)\s+IS\s+NOT\s+NULL/i;

function* walk(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { yield* walk(rel); continue; }
    if (!/\.(ts|mjs|js)$/.test(entry.name)) continue;
    if (/\.test\.|__tests__/.test(rel)) continue;
    yield rel;
  }
}

const violations = [];
for (const rel of [...SCAN_DIRS].flatMap((d) => [...walk(d)])) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const m of src.matchAll(DELETE_RE)) {
    const table = m[1].toLowerCase();
    if (!PROTECTED.has(table)) continue;
    // Look at the statement window around the DELETE (until the next `;` / backtick close, ~12 lines).
    const start = m.index;
    const window = src.slice(start, start + 600);
    if (PURGE_GUARD_RE.test(window)) continue; // retention purge of already-soft-deleted rows — allowed
    const line = src.slice(0, start).split('\n').length;
    violations.push({ rel, line, table });
  }
}

if (violations.length) {
  console.error('✗ no-hard-delete-customer-tables · FAIL — live hard-delete(s) of customer-owned work:');
  for (const v of violations) {
    console.error(`    ${v.rel}:${v.line} · DELETE FROM ${v.table} (not guarded by *_at IS NOT NULL)`);
  }
  console.error('  Customer work must be SOFT-deleted (recoverable). Use UPDATE SET <marker>=now(), or');
  console.error('  guard the DELETE with `archived_at/deleted_at IS NOT NULL` if it is a retention purge.');
  process.exit(1);
}

console.log(`☑ no-hard-delete-customer-tables · PASS · ${PROTECTED.size} protected tables · 0 live hard-deletes`);
process.exit(0);
