#!/usr/bin/env node
// verify-principal-instrument-lineage.mjs · A-W4/P6 · actor-lineage drift + coverage gate (260707).
//
// WHY: the enterprise AI-governance guarantee "every governed write records principal + instrument"
// (docs/governance/PRINCIPAL_INSTRUMENT_LINEAGE.md) only holds if (1) the vocabulary can't drift between
// the TS SSOT and the migration-050 DB CHECKs, (2) the instrumented write paths keep populating lineage,
// and (3) routes never hand-roll instrument kinds outside the SSOT helpers. Three teeth:
//   T1 — enum lockstep: actor-lineage.ts INSTRUMENT_KINDS/AUTHORITY_SOURCES == migration 050 CHECK sets.
//   T2 — coverage: each instrumented call site carries lineageFor( + request_id near its upsertEvent.
//   T3 — no hand-rolled kinds: `instrument_kind: '...'` in routes only inside a lineageFor(...) window.
// Prevention > detection.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SSOT = 'src/workers/lib/actor-lineage.ts';
const MIGRATION = 'src/workers/db/migrations/050_principal_instrument_lineage.sql';

// Instrumented write paths (pass 1). Grows as more upsertEvent call sites adopt.
const INSTRUMENTED = [
  { file: 'src/workers/routes/documents.ts', label: 'document upload mirror' },
  { file: 'src/workers/routes/sign-offs.ts', label: 'sign-off mirror' },
  { file: 'src/workers/routes/projects.ts', label: 'project archive mirror' },
];

const fail = [];
const read = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { fail.push(`${rel} · not found`); return null; }
  return fs.readFileSync(abs, 'utf8');
};
// Strip // line comments first — the SSOT array carries inline comments whose apostrophes would
// otherwise corrupt quote extraction (e.g. "token's grant").
const extractQuoted = (s) => {
  const noComments = s.replace(/\/\/[^\n]*/g, '');
  return [...noComments.matchAll(/'([^']+)'/g)].map((m) => m[1]);
};
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// T1 · enum lockstep (SSOT ↔ migration CHECKs)
const ssot = read(SSOT);
const mig = read(MIGRATION);
if (ssot && mig) {
  const pairs = [
    ['INSTRUMENT_KINDS', /INSTRUMENT_KINDS\s*=\s*\[([^\]]*)\]/, /instrument_kind IN \(([^)]*)\)/],
    ['AUTHORITY_SOURCES', /AUTHORITY_SOURCES\s*=\s*\[([^\]]*)\]/, /authority_source IN\s*\(([^)]*)\)/s],
  ];
  for (const [name, tsRe, sqlRe] of pairs) {
    const tsM = ssot.match(tsRe);
    const sqlM = mig.match(sqlRe);
    if (!tsM) { fail.push(`${SSOT} · ${name} array not found`); continue; }
    if (!sqlM) { fail.push(`${MIGRATION} · CHECK for ${name} not found`); continue; }
    const tsSet = new Set(extractQuoted(tsM[1]));
    const sqlSet = new Set(extractQuoted(sqlM[1]));
    if (!setEq(tsSet, sqlSet)) {
      fail.push(`${name} drift — SSOT {${[...tsSet]}} != migration CHECK {${[...sqlSet]}}`);
    }
  }
}

// T2 · instrumented paths keep their lineage (lineageFor + request_id within the file)
for (const { file, label } of INSTRUMENTED) {
  const src = read(file);
  if (!src) continue;
  if (!/from ['"]\.\.\/lib\/actor-lineage['"]/.test(src)) {
    fail.push(`${file} · ${label} — missing actor-lineage import`);
    continue;
  }
  if (!/\.\.\.lineageFor\(auth\)/.test(src)) {
    fail.push(`${file} · ${label} — no longer spreads lineageFor(auth) into its governed event`);
  }
  if (!/request_id:\s*ctx\.get\('request_id'\)/.test(src)) {
    fail.push(`${file} · ${label} — no longer stamps request_id on its governed event`);
  }
}

// T3 · no hand-rolled instrument_kind literals in routes outside a lineageFor(...) window
const routesDir = path.join(ROOT, 'src/workers/routes');
for (const entry of fs.readdirSync(routesDir)) {
  if (!/\.ts$/.test(entry) || /\.test\./.test(entry)) continue;
  const rel = `src/workers/routes/${entry}`;
  const src = fs.readFileSync(path.join(routesDir, rel.split('/').pop()), 'utf8');
  for (const m of src.matchAll(/instrument_kind:\s*'/g)) {
    const before = src.slice(Math.max(0, m.index - 120), m.index);
    if (!/lineageFor\(|systemLineage/.test(before)) {
      const line = src.slice(0, m.index).split('\n').length;
      fail.push(`${rel}:${line} · hand-rolled instrument_kind literal — use lineageFor()/systemLineage() from the SSOT`);
    }
  }
}

if (fail.length) {
  console.error('✗ principal-instrument-lineage · FAIL:');
  for (const v of fail) console.error(`    ${v}`);
  console.error('  See docs/governance/PRINCIPAL_INSTRUMENT_LINEAGE.md — principal + instrument, never just "by <human>".');
  process.exit(1);
}

console.log(`☑ principal-instrument-lineage · PASS · enums lockstep · ${INSTRUMENTED.length} instrumented paths · 0 hand-rolled kinds`);
process.exit(0);
