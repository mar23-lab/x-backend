#!/usr/bin/env node
// scripts/verify-ia-001-model-invariants.mjs
//
// ADR-XLOOP-IA-001 Phase A6 · HR-INFO-MODEL-INTEGRITY-1 — the two STRUCTURAL invariants
// that nothing else enforces, locked in as forward regression guards (static scan, no DB):
//
//   (1) NO STRUCTURAL TABLE FKs A LENS. Lenses (L2, synthetic_domains) point at the
//       structure; the structure (L0/L1: operation_events, projects, project_source_bindings,
//       intents, workspaces, operations_unified, ...) must NEVER hold a foreign key to
//       synthetic_domains. Only L2 satellites (synthetic_domain_*) may reference it.
//       Catches: a future migration coupling a fact/organization table to a disposable view.
//
//   (2) L0 FACTS ARE APPEND-ONLY. No code path or migration may UPDATE an operation_events
//       BODY column (summary/title/payload/body/raw/content/description/kind). Re-organization
//       is L1 re-pointing (project_id/domain_id/intent_id/status) only — so the operator's
//       work is structurally impossible to lose ("work not lost, restructurable").
//       Catches: an "edit the event to re-classify it" shortcut.
//
// Exit 0 = both invariants hold. Exit 1 = the canonical information model was violated.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const fails = [];
const notes = [];
function expect(label, ok, detail) {
  if (ok) notes.push(`  ☑ ${label}${detail ? ` · ${detail}` : ''}`);
  else fails.push(`  ✗ ${label}${detail ? ` · ${detail}` : ''}`);
}

// ── collect source files (skip build artifacts + node_modules) ────────────────
function walk(dir, exts, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('dist') || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

const migrationsDir = path.join(repoRoot, 'src/workers/db/migrations');
const migrationFiles = walk(migrationsDir, ['.sql']);
const workerTs = walk(path.join(repoRoot, 'src/workers'), ['.ts']);

// ── INVARIANT 1 · no structural table FKs synthetic_domains ──────────────────
// Walk each migration; track the current CREATE TABLE name; a `REFERENCES synthetic_domains`
// is allowed ONLY inside a table whose name starts with `synthetic_domain` (an L2 satellite).
let i1Violations = 0;
let i1RefsSeen = 0;
const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?["']?([a-z0-9_]+)["']?/i;
for (const file of migrationFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  let currentTable = null;
  for (const line of lines) {
    const m = line.match(createRe);
    if (m) currentTable = m[1].toLowerCase();
    if (/references\s+synthetic_domains\b/i.test(line)) {
      i1RefsSeen += 1;
      const ok = currentTable != null && currentTable.startsWith('synthetic_domain');
      if (!ok) {
        i1Violations += 1;
        notes.push(`    ↪ ${path.basename(file)}: table "${currentTable ?? '?'}" → synthetic_domains`);
      }
    }
  }
}
expect('(1) no structural table holds an FK to synthetic_domains (lenses point at structure, never the reverse)',
  i1Violations === 0, `${i1RefsSeen} lens-FK(s) seen, all on L2 satellites`);

// ── INVARIANT 2 · operation_events body is append-only (no UPDATE … SET body) ─
// Allowed SET targets (L1 re-pointing + bookkeeping); forbidden = body/content fields.
const FORBIDDEN_BODY_COLS = ['summary', 'title', 'payload', 'body', 'raw', 'content', 'description', 'kind', 'source_tool'];
const updateRe = /update\s+operation_events\s+set\s+([\s\S]*?)(?:\bwhere\b|;|`)/gi;
let i2Violations = 0;
let i2StmtsSeen = 0;
for (const file of [...workerTs, ...migrationFiles]) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  updateRe.lastIndex = 0;
  while ((m = updateRe.exec(src)) !== null) {
    i2StmtsSeen += 1;
    const setClause = m[1].toLowerCase();
    const hit = FORBIDDEN_BODY_COLS.filter((c) => new RegExp(`\\b${c}\\s*=`).test(setClause));
    if (hit.length > 0) {
      i2Violations += 1;
      notes.push(`    ↪ ${path.basename(file)}: UPDATE operation_events SET ${hit.join(', ')} (body mutation)`);
    }
  }
}
expect('(2) operation_events body is append-only (no UPDATE … SET of a content/body column)',
  i2Violations === 0, `${i2StmtsSeen} operation_events UPDATE(s) seen, none mutate the body`);

// ── receipt ───────────────────────────────────────────────────────────────────
console.log('ADR-XLOOP-IA-001 Phase A6 · canonical information-model invariants');
console.log('─'.repeat(64));
console.log(notes.join('\n'));
console.log('─'.repeat(64));
if (fails.length) {
  console.error(`✗ info-model invariant BROKEN · ${fails.length} violation(s):`);
  console.error(fails.join('\n'));
  process.exit(1);
}
console.log('☑ info-model invariants hold · no structural→lens FK · L0 facts append-only');
process.exit(0);
