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
//
// 260728 — THIS USED TO HARDCODE `xlooop_app`, SO IT MEASURED 25% OF THE SURFACE AND SAID PASS.
// Live production has FOUR non-owner grantees: xlooop_app (30 tables), xlooop_rls_app_public_gate_260623
// (5), xlooop_graph_ro (4) and telemetry_ro (1). Only the first was ever checked. xlooop_graph_ro held
// SELECT on graph_nodes / graph_edges / graph_snapshots / v_artefact_lineage — all four carry
// workspace_id, all four had RLS DISABLED with zero policies, 28,077 rows across 8 tenants — and this
// gate reported PASS the whole time. The invariant in the header above ("a table GRANTed without RLS is
// readable across every tenant") was never role-specific; only the implementation was.
//
// Owner/superuser roles stay excluded deliberately: they bypass RLS by construction, so a grant to them
// is not a tenant-boundary claim. Every OTHER grantee is now in scope.
const OWNER_ROLES = new Set(['neondb_owner', 'neon_superuser', 'postgres', 'public']);
const granted = new Map(); // table -> Set(migration files)
const granteesByTable = new Map(); // table -> Set(role)
for (const { file, text } of corpus) {
  for (const m of text.matchAll(/GRANT\s+([A-Z, ]+?)\s+ON\s+([a-z_,\s]+?)\s+TO\s+([a-z_][a-z0-9_]*)/gi)) {
    const privileges = m[1].trim().toUpperCase();
    if (/SCHEMA|SEQUENCE|FUNCTION/i.test(privileges)) continue; // not table reads
    const grantee = m[3].trim().toLowerCase();
    if (OWNER_ROLES.has(grantee)) continue;
    for (const rawTable of m[2].split(',')) {
      const table = rawTable.trim().toLowerCase();
      if (!table || table === 'all' || /schema|sequences|functions/.test(table)) continue;
      if (!granted.has(table)) granted.set(table, new Set());
      granted.get(table).add(file);
      if (!granteesByTable.has(table)) granteesByTable.set(table, new Set());
      granteesByTable.get(table).add(grantee);
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

// ── LIVE COMPANION (--live, needs DATABASE_URL) ────────────────────────────────────────────────
//
// WHY THIS EXISTS AND WHY THE STATIC PASS ABOVE IS NOT ENOUGH.
// The corpus scan can only see roles and grants that a migration created. `xlooop_graph_ro` was
// created OUT OF BAND and appears in ZERO migration files — `grep -rn 'xlooop_graph_ro'
// src/workers/db/migrations/` returns nothing. So no corpus-reading gate, however well written,
// could ever have seen it. Widening the role match above closes the in-corpus half of the hole;
// only a live query closes the other half.
//
// This is the same lesson as the empty-database proof (a9e29d5): a check that cannot observe the
// thing it certifies is not a check. It fails CLOSED — an unreachable database is an error, never
// a pass, because "could not measure" must never render as "measured clean".
const wantLive = process.argv.includes('--live');
const liveFindings = [];
let liveGranteeCount = 0;
if (wantLive) {
  if (!process.env.DATABASE_URL) {
    console.error('FAIL rls-grant-parity --live: DATABASE_URL is required. Refusing to report a pass without measuring.');
    process.exit(1);
  }
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT g.grantee,
           g.table_name,
           c.relrowsecurity AS rls_enabled,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
           EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public'
               AND col.table_name = g.table_name
               AND col.column_name = 'workspace_id'
           ) AS tenant_bearing
      FROM information_schema.role_table_grants g
      JOIN pg_class c ON c.relname = g.table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE g.privilege_type = 'SELECT'
       AND lower(g.grantee) NOT IN ('neondb_owner','neon_superuser','postgres','public')
     GROUP BY g.grantee, g.table_name, c.relrowsecurity, c.oid`;
  liveGranteeCount = new Set(rows.map((r) => r.grantee)).size;
  for (const r of rows) {
    if (r.rls_enabled) continue;
    if (!r.tenant_bearing) continue; // no workspace_id ⇒ not a tenant boundary (e.g. pg_stat_statements)
    if (EXEMPT[r.table_name]) continue;
    liveFindings.push({ table: r.table_name, grantee: r.grantee, live: true, policies: Number(r.policies) });
  }
  console.log(
    `rls-grant-parity --live: ${rows.length} SELECT grant(s) across ${liveGranteeCount} non-owner grantee(s)`,
  );
}

const allFindings = [...findings, ...liveFindings];

console.log(
  `rls-grant-parity: ${granted.size} table(s) granted to ${new Set([...granteesByTable.values()].flatMap((s) => [...s])).size} `
  + `non-owner role(s) in the corpus · ${rlsEnabled.size} table(s) with RLS · ${Object.keys(EXEMPT).length} exemption(s)`,
);

if (allFindings.length) {
  console.error('\nFAIL rls-grant-parity: table(s) GRANTed to a NOBYPASSRLS role with NO row-level security.');
  console.error("Any read of these on that role's connection returns EVERY tenant's rows.\n");
  for (const f of allFindings) {
    if (f.live) {
      console.error(`  ${f.table}  · LIVE · granted SELECT to ${f.grantee} · RLS disabled, ${f.policies} policies, carries workspace_id`);
    } else {
      const who = [...(granteesByTable.get(f.table) || [])].join(', ') || 'unknown role';
      console.error(`  ${f.table}  · granted to ${who} in ${f.files.join(', ')} · no ENABLE ROW LEVEL SECURITY in the corpus`);
    }
  }
  console.error('\nFix: add the policy (the 043 shape — ENABLE ROW LEVEL SECURITY + workspace USING/WITH CHECK),');
  console.error('or add a reasoned exemption to EXEMPT in this file naming the containment AND what breaks it.');
  console.error('If the role legitimately needs cross-tenant reads, that is an explicit BYPASSRLS exemption');
  console.error('with a named owner and a documented consumer — not an absent policy.');
  process.exit(1);
}

for (const t of staleExemptions) console.log(`  note: exemption for ${t} is now redundant — the table has RLS; drop it.`);
for (const t of unusedExemptions) console.log(`  note: exemption for ${t} is unused — no grant found; drop it.`);
for (const [t, e] of Object.entries(EXEMPT)) {
  if (granted.has(t) && !rlsEnabled.has(t)) console.log(`  exempt: ${t} — breaks if ${e.breaks_if}`);
}
console.log(
  wantLive
    ? `PASS rls-grant-parity: every table granted to any of ${liveGranteeCount} non-owner role(s) — measured LIVE — has RLS or a reasoned exemption.`
    : 'PASS rls-grant-parity: every table granted to a non-owner role IN THE CORPUS has RLS or a reasoned exemption.'
      + ' (static only — roles created out of band are invisible here; run with --live to measure the database.)',
);
process.exit(0);
