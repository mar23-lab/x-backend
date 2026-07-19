#!/usr/bin/env node
// verify-rls-grant-parity.mjs · the invariant behind the whole RLS cutover, made checkable.
//
// WHY. `xlooop_app` is the NOBYPASSRLS role (037). Routing a read through it is only a real
// tenant boundary if the table it reads HAS row-level security: a table GRANTed to xlooop_app
// with no RLS is readable across every tenant the moment a query touches it on that connection —
// Postgres applies no policy where none exists. Today that pairing is enforced by nothing but
// migration authors reading each other's header comments (047 argues its folder_snapshots grant
// is safe, in prose). That is a rule with no tool — the exact shape PR #1619 gated for
// registries, here on the security boundary.
//
// This gate reads the migration corpus and fails when a table is granted to xlooop_app without
// RLS, unless it carries an explicit, reasoned exemption below. It is the STATIC companion to
// the live RLS soak (readiness blocker 5): the soak proves the policies that exist work; this
// proves no granted table is missing one. A soak can pass while a policy-less granted table
// leaks — "a correct green at the wrong resolution".
//
// Use:
//   node scripts/verify-rls-grant-parity.mjs      # exit 1 on an unexempted granted-without-RLS table
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'workers', 'db', 'migrations');

// EXEMPTIONS — each needs a reason and the migration that argued it. An exemption says
// "granted without RLS is SAFE HERE because of a named containment"; it must also name what
// would BREAK that containment, so the next author knows exactly what not to do.
// folder_snapshots was exempted here (047 grant, prose-argued containment) until Wave M-B (260719):
// migration 084 adds its dedicated workspace policy, so it now satisfies parity via RLS rather than a
// prose exemption. The exemption is removed — the gate enforces folder_snapshots going forward.
const EXEMPT = {};

const sqlFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const corpus = sqlFiles.map((f) => ({ file: f, text: readFileSync(join(MIGRATIONS, f), 'utf8') }));

// Tables that have RLS switched on anywhere in the corpus.
const rlsEnabled = new Set();
for (const { text } of corpus) {
  for (const m of text.matchAll(/ALTER\s+TABLE\s+([a-z_]+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)) {
    rlsEnabled.add(m[1].toLowerCase());
  }
}

// Tables granted to xlooop_app anywhere in the corpus. Handles the bare form and the
// EXECUTE '...' form used inside DO blocks, plus comma-separated table lists.
const granted = new Map(); // table -> Set(migration files)
for (const { file, text } of corpus) {
  for (const m of text.matchAll(/GRANT\s+([A-Z, ]+?)\s+ON\s+([a-z_,\s]+?)\s+TO\s+xlooop_app/gi)) {
    const privileges = m[1].trim().toUpperCase();
    if (/SCHEMA|SEQUENCE|FUNCTION/i.test(privileges)) continue; // not table reads
    for (const rawTable of m[2].split(',')) {
      const table = rawTable.trim().toLowerCase();
      if (!table || table === 'all' || /schema|sequences|functions/.test(table)) continue;
      if (!granted.has(table)) granted.set(table, new Set());
      granted.get(table).add(file);
    }
  }
}

const findings = [];
for (const [table, files] of [...granted].sort()) {
  if (rlsEnabled.has(table)) continue;
  if (EXEMPT[table]) continue;
  findings.push({ table, files: [...files] });
}

// An exemption for a table that has since gained RLS is stale bookkeeping, not a failure.
const staleExemptions = Object.keys(EXEMPT).filter((t) => rlsEnabled.has(t));
const unusedExemptions = Object.keys(EXEMPT).filter((t) => !granted.has(t));

console.log(
  `rls-grant-parity: ${granted.size} table(s) granted to xlooop_app · ${rlsEnabled.size} table(s) with RLS · `
  + `${Object.keys(EXEMPT).length} exemption(s)`,
);

if (findings.length) {
  console.error('\nFAIL rls-grant-parity: table(s) GRANTed to the NOBYPASSRLS role with NO row-level security.');
  console.error("Any read of these on the xlooop_app connection returns EVERY tenant's rows.\n");
  for (const f of findings) {
    console.error(`  ${f.table}  · granted in ${f.files.join(', ')} · no ENABLE ROW LEVEL SECURITY in the corpus`);
  }
  console.error('\nFix: add the policy (the 043 shape — ENABLE ROW LEVEL SECURITY + workspace USING/WITH CHECK),');
  console.error('or add a reasoned exemption to EXEMPT in this file naming the containment AND what breaks it.');
  process.exit(1);
}

for (const t of staleExemptions) console.log(`  note: exemption for ${t} is now redundant — the table has RLS; drop it.`);
for (const t of unusedExemptions) console.log(`  note: exemption for ${t} is unused — no grant found; drop it.`);
for (const [t, e] of Object.entries(EXEMPT)) {
  if (granted.has(t) && !rlsEnabled.has(t)) console.log(`  exempt: ${t} — breaks if ${e.breaks_if}`);
}
console.log('PASS rls-grant-parity: every table granted to xlooop_app has RLS or a reasoned exemption.');
process.exit(0);
