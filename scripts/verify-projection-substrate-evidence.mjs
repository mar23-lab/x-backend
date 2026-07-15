#!/usr/bin/env node
// scripts/verify-projection-substrate-evidence.mjs
//
// ADR-XLOOP-ARCH-004 · HR-PROJECTION-SUBSTRATE-EVIDENCE-1 teeth. A projection/read-model may not be
// claimed "fed/live/done" without EVIDENCE that its source tables contain data. Rectifies defect S1:
// the data-graph was shipped + governed + deployed while every lineage source table was empty in prod
// ("wired but unfed"). Offline checks (the live census is recorded in the manifest, refreshed by a
// read-only prod query):
//   (1) the substrate manifest exists + declares the projection's source tables.
//   (2) MANIFEST ⊇ CODE: every table the persistence module READS (FROM <t>) is declared in the manifest
//       (a new uncensused source read is a defect — you cannot census what you did not declare).
//   (3) the census block is present + dated + has an explicit numeric or `unobserved` state for every
//       declared core table. `unobserved` is allowed only while status is not `fed`.
//   (4) HONESTY: persisted_graph_nodes == 0 ⇒ status MUST be `wired_not_fed` (a `fed`/`partially_fed`
//       claim on an empty persisted graph FAILS — the exact S1 defect).
//
// `--self-test` proves the gate BITES: a manifest claiming `fed` with persisted_graph_nodes:0 must FAIL;
// a coherent manifest must PASS.
//
// Exit 0 = the substrate-evidence invariant holds. Exit 1 = violated.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const P = (...a) => path.join(repoRoot, ...a);
const read = (rel) => { try { return fs.readFileSync(P(rel), 'utf8'); } catch { return null; } };

const MANIFEST = 'docs/graph/GRAPH_SUBSTRATE_MANIFEST.yml';

// Minimal YAML probes (no dep): we only need declared tables, the census row-count keys, status,
// and persisted_graph_nodes. The manifest is hand-maintained + small, so line-scan is sufficient.
function parseManifest(text) {
  const tables = [...text.matchAll(/^\s*-\s*table:\s*([A-Za-z0-9_]+)\s*$/gm)].map((m) => m[1]);
  const roleByTable = {};
  // pair each `- table: X` with the following `role: Y`
  const blocks = text.split(/^\s*-\s*table:\s*/m).slice(1);
  for (const b of blocks) {
    const name = (b.match(/^([A-Za-z0-9_]+)/) || [])[1];
    const role = (b.match(/role:\s*([a-z_]+)/) || [])[1];
    if (name) roleByTable[name] = role || 'core';
  }
  const status = (text.match(/^status:\s*([a-z_]+)\s*$/m) || [])[1] || '';
  const persistedNodes = Number((text.match(/persisted_graph_nodes:\s*(\d+)/) || [])[1]);
  const dated = (text.match(/dated:\s*['"]?([0-9T:\-Z]+)/) || [])[1] || '';
  const rowCounts = Object.fromEntries([...text.matchAll(/^\s{4,}([A-Za-z0-9_]+):\s*(\d+)/gm)].map((m) => [m[1], Number(m[2])]));
  const rowCountKeys = Object.keys(rowCounts);
  const unobservedKeys = [...text.matchAll(/^\s{4,}([A-Za-z0-9_]+):\s*unobserved\s*(?:#.*)?$/gm)].map((m) => m[1]);
  const persistedEdges = Number((text.match(/persisted_graph_edges:\s*(\d+)/) || [])[1]);
  const intentCount = rowCounts.intents ?? 0;
  const causationCount = rowCounts.audit_logs_with_causation_id ?? 0;
  const packetCount = rowCounts.task_packets ?? 0;
  return { tables, roleByTable, status, persistedNodes, persistedEdges, dated, rowCounts, rowCountKeys, unobservedKeys, intentCount, causationCount, packetCount };
}

function censusAgeDays(dated, now = new Date()) {
  const value = new Date(dated);
  if (!dated || Number.isNaN(value.getTime())) return Number.POSITIVE_INFINITY;
  return (now.getTime() - value.getTime()) / 86_400_000;
}

function pilotViolations(m, now = new Date()) {
  const v = [];
  const age = censusAgeDays(m.dated, now);
  if (age > 7) v.push(`census age ${age.toFixed(2)}d exceeds 7d`);
  if (m.intentCount <= 0) v.push('intent_count must be > 0');
  if (m.causationCount <= 0) v.push('caused_by source count must be > 0');
  if (m.packetCount <= 0) v.push('task_packet_count must be > 0');
  if ((m.persistedNodes || 0) <= 0 || (m.persistedEdges || 0) <= 0) v.push('persisted graph nodes and edges must be > 0');
  if (m.unobservedKeys.length) v.push(`unobserved census rows: ${m.unobservedKeys.join(', ')}`);
  return v;
}

// the should-FAIL / should-PASS pair for --self-test
function honestyViolations(m) {
  const v = [];
  const VALID = ['wired_not_fed', 'partially_fed', 'fed'];
  if (!VALID.includes(m.status)) v.push(`invalid status '${m.status}'`);
  if ((Number.isNaN(m.persistedNodes) ? 0 : m.persistedNodes) === 0 && m.status !== 'wired_not_fed') {
    v.push(`status='${m.status}' but persisted_graph_nodes==0 → MUST be 'wired_not_fed' (S1: wired-but-unfed claimed as fed)`);
  }
  return v;
}

if (process.argv.includes('--self-test')) {
  const passManifest = { tables: ['x'], roleByTable: {}, status: 'wired_not_fed', persistedNodes: 0, dated: 't', rowCountKeys: [], unobservedKeys: ['x'] };
  const failManifest = { tables: ['x'], roleByTable: {}, status: 'fed', persistedNodes: 0, dated: 't', rowCountKeys: [], unobservedKeys: ['x'] };
  const passOk = honestyViolations(passManifest).length === 0;
  const failBites = honestyViolations(failManifest).length > 0;
  const pilotBites = pilotViolations({ dated: '2026-01-01T00:00:00Z', intentCount: 0, causationCount: 0, packetCount: 0, persistedNodes: 1, persistedEdges: 1, unobservedKeys: [] }, new Date('2026-07-15T00:00:00Z')).length >= 3;
  if (passOk && failBites && pilotBites) { console.log('☑ self-test: honesty and strict-pilot gates BITE'); process.exit(0); }
  console.error(`✗ self-test: gate did not bite (passOk=${passOk}, failBites=${failBites})`); process.exit(1);
}

const fails = [];
const notes = [];
const ok = (label, pass, detail) => { (pass ? notes : fails).push(`  ${pass ? '☑' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`); };

const text = read(MANIFEST);
if (!text) {
  ok('(1) the graph substrate manifest exists', false, `${MANIFEST} missing`);
} else {
  const m = parseManifest(text);
  ok('(1) manifest declares source tables', m.tables.length >= 5, `${m.tables.length} tables`);

  // (2) MANIFEST ⊇ CODE — every FROM <table> in graph-store.ts is declared (ignore graph_*/CTE aliases).
  const store = read('src/workers/dal/graph-store.ts') || '';
  // UPPERCASE FROM only — SQL convention in this codebase; avoids matching lowercase prose ("from the")
  // in comments. Subqueries (`FROM (`) and graph_*/view/unnest aliases are excluded.
  const fromTables = [...store.matchAll(/\bFROM\s+([a-z_][a-z0-9_]*)/g)].map((x) => x[1].toLowerCase())
    .filter((t) => !/^graph_|^v_artefact|^unnest/.test(t));
  const undeclared = [...new Set(fromTables)].filter((t) => !m.tables.includes(t));
  ok('(2) every source table read by graph-store.ts is declared in the manifest', undeclared.length === 0,
    undeclared.length ? `undeclared (uncensused) reads: ${undeclared.join(', ')}` : `${new Set(fromTables).size} source reads declared`);

  // (3) census present + dated + an explicit state for each declared CORE table. A new source may be
  // recorded as unobserved instead of inventing a count, but fed is forbidden until all are measured.
  ok('(3) census is dated', !!m.dated, m.dated || 'no dated census');
  const coreTables = m.tables.filter((t) => (m.roleByTable[t] || 'core') === 'core');
  const missingCensus = coreTables.filter((t) => !m.rowCountKeys.includes(t) && !m.unobservedKeys.includes(t));
  ok('(3) every CORE source table has an explicit census state', missingCensus.length === 0,
    missingCensus.length ? `no census state for: ${missingCensus.join(', ')}` : `${coreTables.length} core tables declared`);
  ok('(3) fed status has no unobserved CORE sources', m.status !== 'fed' || m.unobservedKeys.length === 0,
    m.unobservedKeys.length ? `unobserved: ${m.unobservedKeys.join(', ')}` : 'all observed');

  // (4) HONESTY — the S1 gate
  const hv = honestyViolations(m);
  ok('(4) status is honest vs the census (no fed/live claim on an empty persisted graph)', hv.length === 0, hv.join(' | '));

  if (process.argv.includes('--strict-pilot')) {
    const pv = pilotViolations(m);
    ok('(5) pilot census is fresh and contains packet, intent, and causation lineage', pv.length === 0, pv.join(' | '));
  }
}

console.log('ADR-XLOOP-ARCH-004 · projection substrate-evidence (HR-PROJECTION-SUBSTRATE-EVIDENCE-1)');
console.log('─'.repeat(70));
console.log(notes.join('\n'));
if (fails.length) {
  console.error('─'.repeat(70));
  console.error(`✗ substrate-evidence BROKEN · ${fails.length} violation(s):`);
  console.error(fails.join('\n'));
  console.error('\n  Refresh the census (read-only prod):');
  console.error("    SELECT (SELECT count(*) FROM graph_nodes) AS persisted_graph_nodes, (SELECT count(*) FROM operation_events) AS operation_events, ...;");
  process.exit(1);
}
console.log('─'.repeat(70));
console.log('☑ projection substrate is declared + censused + the fed/unfed status is honest');
process.exit(0);
