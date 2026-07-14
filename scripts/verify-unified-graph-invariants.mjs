#!/usr/bin/env node
// scripts/verify-unified-graph-invariants.mjs
//
// ADR-XLOOP-IA-001 R3 · HR-UNIFIED-GRAPH-DERIVED-1 teeth. Asserts the unified data-graph is a DERIVED
// PROJECTION, not a parallel SSOT: (1) the projection module is PURE (reads + joins; no DB write / no
// fact mutation); (2) it exports the projection + the typed domain_id resolver + the hash; (3) every
// node carries workspace_id + the bitemporal stamps; (4) the projection's invariant test passes (the
// runtime proof: tenant isolation, lens→project-never-reverse, drift-detectable hash).
//
// Exit 0 = the unified-graph derived-projection invariants hold. Exit 1 = violated.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const P = (...a) => path.join(repoRoot, ...a);
const read = (rel) => { try { return fs.readFileSync(P(rel), 'utf8'); } catch { return null; } };

const MODULE = 'src/workers/graph/data-graph.ts';
const TEST = 'src/workers/__tests__/data-graph.test.ts';

const fails = [];
const notes = [];
const ok = (label, pass, detail) => { (pass ? notes : fails).push(`  ${pass ? '☑' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`); };

const src = read(MODULE);
if (!src) {
  ok('the data-graph projection module exists', false, `${MODULE} missing`);
} else {
  // (1) PURE — no DB write / no side effect. Catches tagged-template SQL, raw SQL verbs,
  // AND the non-SQL write surfaces a 4-pattern scan used to miss (F9): D1/SQLite
  // .prepare().run()/.exec(), KV/R2 .put(), DB .batch(), an outbound fetch POST, and fs writes.
  const writeHit = src.match(
    /\bsql\s*`|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|\.\s*(?:run|exec|batch)\s*\(|\.\s*put\s*\(|\bfetch\s*\([^)]*method\s*:\s*['"]POST|\bfs\.\w*write/i,
  );
  ok('(1) projection module is PURE (no DB write / no embedded SQL / no side effect)', !writeHit, writeHit ? `found: ${writeHit[0]}` : 'pure');
  // (2) exports the projection + the typed resolver + the hash
  for (const sym of ['buildDataGraph', 'resolveDomainId', 'computeGraphHash']) {
    ok(`(2) exports ${sym}`, new RegExp(`export\\s+function\\s+${sym}\\b`).test(src), null);
  }
  // (3) GraphNode carries workspace_id + both bitemporal stamps
  const nodeIface = (src.match(/export interface GraphNode\s*\{[\s\S]*?\}/) || [''])[0];
  ok('(3) GraphNode carries workspace_id + occurred_at + ingested_at',
    /workspace_id\s*:/.test(nodeIface) && /occurred_at\??\s*:/.test(nodeIface) && /ingested_at\??\s*:/.test(nodeIface), null);
  // the builder never re-points a fact (no UPDATE-of-fact shortcut leaking in)
  ok('(4) builder takes facts + returns nodes/edges/snapshot (projection signature)',
    /export function buildDataGraph\([^)]*\)\s*:\s*\{\s*nodes/.test(src), null);

  // ── ADR-XLOOP-ARCH-003 VI.4 · lineage-completeness (HR-PRODUCT-GRAPH-PROJECTION-1) ──
  // (6) lineage completeness — every node carries a DERIVED description (non-empty fallback) +
  //     the source→project feeds edge exists (the chain starts at the connected source).
  ok('(6) GraphNode carries a derived `description` field', /description\??\s*:\s*string\s*\|\s*null/.test(src), null);
  ok('(6) descriptions are derived via a non-empty helper (never label-less)', /\bnonEmpty\(/.test(src), null);
  ok('(6) the source → project `feeds` lineage-origin edge is emitted', /addEdge\([^,]+,[^,]+,\s*'feeds'\)/.test(src), null);
  // (7) NO-L0-description — descriptions derive from title/summary/source_ref, NEVER an L0 column.
  //     The projection + its facts-assembly must not SELECT a `description` from operation_events/audit_logs.
  const gstore = read('src/workers/dal/graph-store.ts') || '';
  const l0DescLeak = /operation_events[\s\S]{0,120}\bdescription\b/i.test(gstore) || /audit_logs[\s\S]{0,120}\bdescription\b/i.test(gstore)
    || /\boperation_events\b[\s\S]{0,80}description/i.test(src);
  ok('(7) NO-L0-description — no `description` read from operation_events/audit_logs (derived only)', !l0DescLeak, l0DescLeak ? 'an L0 description read leaked in' : 'derived only');
  // (8) source-points-at-binding — a source node ref_id == a project_source_bindings.id; the
  //     projection never mutates the binding (one-directional, like lens→project).
  ok("(8) source node ref_id is a binding id (source:${b.id}, ref_id: b.id)",
    /id:\s*sid[\s\S]{0,60}ref_id:\s*b\.id/.test(src) || /`source:\$\{b\.id\}`/.test(src), null);
}

// (5) run the runtime invariant proof (offline, fast)
if (!read(TEST)) {
  ok('(5) the projection invariant test exists', false, `${TEST} missing`);
} else {
  try {
    execSync(`npx vitest run ${TEST} --reporter dot`, { cwd: repoRoot, stdio: 'pipe', timeout: 120000 });
    ok('(5) projection invariant test passes (tenant isolation · lens→project-only · pure · drift-hash)', true, 'vitest green');
  } catch (e) {
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    ok('(5) projection invariant test passes', false, `vitest FAILED: ${out.split('\n').filter((l) => /✗|FAIL|Error/.test(l)).slice(0, 2).join(' | ').slice(0, 200)}`);
  }
}

console.log('ADR-XLOOP-IA-001 R3 · unified data-graph derived-projection invariants');
console.log('─'.repeat(64));
console.log(notes.join('\n'));
if (fails.length) {
  console.error('─'.repeat(64));
  console.error(`✗ unified-graph invariant BROKEN · ${fails.length} violation(s):`);
  console.error(fails.join('\n'));
  process.exit(1);
}
console.log('─'.repeat(64));
console.log('☑ unified data-graph is a pure derived projection · workspace-scoped · bitemporal · drift-detectable');
process.exit(0);
