#!/usr/bin/env node
// verify-prod-migrations.mjs · 2026-06-07 · object-probe added 2026-07-19 (audit D2)
//
// WHY THIS EXISTS
//   Prod Neon migrations are applied MANUALLY (`db:migrate:prod` is just an
//   echo — there is no runner). So a migration file can be authored, merged,
//   and assumed-live yet never actually reach prod. On 2026-06-06 this had
//   silently shipped TWO broken features:
//     * 015_synthetic_domain_derivation_identity — synthetic_domains was
//       missing source_domains / derivation_fingerprint / derivation_version /
//       derivative_mutation_allowed, so create/read of any synthetic domain
//       500'd (60 references in WorkersDalAdapter.ts).
//     * 016_project_source_bindings — the table did not exist, so every
//       project-source binding (incl. the new GitHub repo picker) 500'd on save.
//     Both were the two most-recent migrations; the manual step had skipped them.
//
// WHY THE OBJECT PROBE (audit D2, 2026-07-19)
//   The ledger-only check FALSE-POSITIVES and FALSE-NEGATIVES because
//   `workers_schema_version` is a hand-maintained row, not the object itself:
//     * 037/038 tables EXISTED on prod but their ledger row was never written →
//       ledger-only reported "MISSING" (a false alarm).
//     * 063/064/065 had (in an intermediate state) a plausible ledger yet the
//       tables were ABSENT — the DANGEROUS case: deployed code references
//       mcp_access_log / llm_usage_log / idempotency_keys and 500s live.
//   Proxy (the ledger row) lied in BOTH directions. So we also probe the ACTUAL
//   object with `to_regclass()` and classify every migration by the (ledger,
//   object) pair. A migration whose key TABLE is absent while the ledger claims
//   applied is a hard FAIL (it can be live-500ing). A table present but ledger
//   absent is a WARN (benign — back-fill the ledger row).
//
// WHAT IT DOES
//   Compares src/workers/db/migrations/NNN_*.sql against workers_schema_version
//   AND against actual object existence (to_regclass of the CREATE TABLE each
//   migration declares). ALTER/INDEX/RLS-only migrations have no key table to
//   probe and fall back to the ledger check.
//
// USAGE
//   DATABASE_URL=postgres://... node scripts/verify-prod-migrations.mjs
//   node scripts/verify-prod-migrations.mjs            # (no DB) lists files, exits 1
//   node scripts/verify-prod-migrations.mjs --self-test  # classifier RED/GREEN control, no DB
//
// FLAGS
//   --warn-only   exit 0 even if gaps found (default: exit 2 on gaps)
//   --json        emit machine-readable JSON
//   --no-probe    ledger-only (legacy behaviour; skip to_regclass object probe)
//   --self-test   run the pure classifier against synthetic fixtures and exit
//
// EXIT CODES
//   0  every migration is applied AND its key object exists (or --warn-only)
//   1  missing DATABASE_URL or migrations dir unreadable
//   2  gap(s): migration not recorded as applied, OR ledger-applied but object ABSENT
//   3  DB connection / query failed
//   4  --self-test failed (classifier regression)

// NOTE: '@neondatabase/serverless' is imported LAZILY inside main() so that
// --self-test and the no-DB file listing run with zero dependencies (a gate can
// prove the classifier without `npm install`).
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../src/workers/db/migrations');
const argv = process.argv.slice(2);
const WARN_ONLY = argv.includes('--warn-only');
const JSON_OUT = argv.includes('--json');
const NO_PROBE = argv.includes('--no-probe');
const SELF_TEST = argv.includes('--self-test');
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

function parseFileVersions() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ version: parseInt(f.match(/^(\d+)_/)[1], 10), file: f }))
    .sort((a, b) => a.version - b.version || a.file.localeCompare(b.file));
}

// Extract the primary CREATE TABLE object a migration declares (the thing whose
// existence proves the migration reached the DB). Returns the bare, lower-cased,
// unqualified table name, or null for ALTER/INDEX/RLS/GRANT-only migrations that
// create no table (those fall back to the ledger check). Deliberately conservative:
// we probe TABLES only — a table is the object deployed code selects/inserts on and
// whose absence 500s; indexes/constraints degrade but rarely hard-500.
export function parseKeyTable(sqlText) {
  // CREATE TABLE [IF NOT EXISTS] [schema.]"?name"? — first match wins.
  const m = sqlText.match(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[a-zA-Z_][\w]*"?\.)?"?([a-zA-Z_][\w]*)"?/i,
  );
  return m ? m[1].toLowerCase() : null;
}

// PURE classifier — no DB, no fs. Given the migration list, the applied-version
// set, and a map of tableName -> boolean(objectExists), return a verdict per
// migration. This is the unit under --self-test.
//   verdicts:
//     ok                 ledger-applied AND (no key table OR object present)
//     object-missing     ledger-applied BUT key table ABSENT   -> HARD FAIL (live-500 risk)
//     ledger-missing     key table PRESENT but ledger row absent -> WARN (back-fill ledger)
//     unapplied          key table ABSENT and ledger row absent  -> HARD FAIL (genuinely not applied)
//     unapplied-noprobe  no key table, ledger row absent          -> HARD FAIL (can't probe; trust ledger)
export function classify(migrations, appliedSet, objectPresent) {
  return migrations.map((mig) => {
    const applied = appliedSet.has(mig.version);
    const keyTable = mig.keyTable ?? null;
    const probed = keyTable != null && objectPresent instanceof Map && objectPresent.has(keyTable);
    const objectExists = probed ? objectPresent.get(keyTable) === true : null;
    let verdict;
    if (keyTable == null || objectExists == null) {
      // No probe available (ALTER-only, or probe skipped) — ledger is the only signal.
      verdict = applied ? 'ok' : 'unapplied-noprobe';
    } else if (applied && objectExists) verdict = 'ok';
    else if (applied && !objectExists) verdict = 'object-missing';
    else if (!applied && objectExists) verdict = 'ledger-missing';
    else verdict = 'unapplied';
    return { ...mig, applied, keyTable, objectExists, verdict };
  });
}

const HARD_FAIL = new Set(['object-missing', 'unapplied', 'unapplied-noprobe']);
const WARN = new Set(['ledger-missing']);

function runSelfTest() {
  const migs = [
    { version: 63, file: '063_mcp_access_log.sql', keyTable: 'mcp_access_log' },
    { version: 37, file: '037_customer_api_tokens.sql', keyTable: 'customer_api_tokens' },
    { version: 40, file: '040_outlook_source.sql', keyTable: null },        // ALTER-only
    { version: 99, file: '099_ghost.sql', keyTable: 'ghost_table' },
  ];
  const applied = new Set([63, 40, 99]);           // 37 NOT in ledger; 99 in ledger
  const present = new Map([
    ['mcp_access_log', true],                       // 63: applied + present -> ok
    ['customer_api_tokens', true],                  // 37: ledger-absent + present -> ledger-missing (WARN)
    ['ghost_table', false],                         // 99: ledger-present + absent -> object-missing (HARD FAIL, the 063/064/065 class)
  ]);
  const got = classify(migs, applied, present);
  const byV = Object.fromEntries(got.map((g) => [g.version, g.verdict]));
  const expect = { 63: 'ok', 37: 'ledger-missing', 40: 'ok', 99: 'object-missing' };
  const fails = [];
  for (const [v, want] of Object.entries(expect)) {
    if (byV[v] !== want) fails.push(`v${v}: expected ${want}, got ${byV[v]}`);
  }
  // RED control: the dangerous case MUST be a hard fail, the benign case MUST NOT.
  if (!HARD_FAIL.has(byV[99])) fails.push('v99 (ledger-present/object-absent) must be HARD FAIL');
  if (HARD_FAIL.has(byV[37])) fails.push('v37 (table-present/ledger-absent) must NOT be a hard fail');
  if (fails.length) {
    console.error('SELF-TEST FAIL:\n  ' + fails.join('\n  '));
    process.exit(4);
  }
  console.log('SELF-TEST PASS · classifier separates object-missing (FAIL) from ledger-missing (WARN)');
  console.log('  verdicts: ' + JSON.stringify(byV));
  process.exit(0);
}

async function main() {
  if (SELF_TEST) return runSelfTest();

  let fileVersions;
  try {
    fileVersions = parseFileVersions();
  } catch (e) {
    console.error(`verify-prod-migrations · cannot read ${MIGRATIONS_DIR}: ${e.message}`);
    process.exit(1);
  }
  if (!fileVersions.length) {
    console.error(`verify-prod-migrations · no NNN_*.sql migration files in ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  // Attach each migration's key table (parsed once, from disk).
  for (const f of fileVersions) {
    try { f.keyTable = parseKeyTable(readFileSync(resolve(MIGRATIONS_DIR, f.file), 'utf8')); }
    catch { f.keyTable = null; }
  }

  if (!process.env.DATABASE_URL) {
    log(`verify-prod-migrations · ${fileVersions.length} migration files found:`);
    for (const f of fileVersions) log(`   ${String(f.version).padStart(3, '0')}  ${f.file}${f.keyTable ? `  [table: ${f.keyTable}]` : '  [no table]'}`);
    log('');
    log('Set DATABASE_URL to compare against workers_schema_version AND probe object existence.');
    if (JSON_OUT) console.log(JSON.stringify({
      error: 'DATABASE_URL not set',
      files: fileVersions,
      ok: false,
      warn_only: WARN_ONLY,
    }, null, 2));
    process.exit(WARN_ONLY ? 0 : 1);
  }

  let applied;
  let objectPresent = new Map();
  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`SELECT version FROM workers_schema_version ORDER BY version`;
    applied = new Set(rows.map((r) => Number(r.version)));

    if (!NO_PROBE) {
      const names = [...new Set(fileVersions.map((f) => f.keyTable).filter(Boolean))];
      if (names.length) {
        // One round-trip: to_regclass(name) IS NOT NULL for every declared table.
        const presRows = await sql`
          SELECT n AS name, to_regclass(n) IS NOT NULL AS present
          FROM unnest(${names}::text[]) AS n`;
        for (const r of presRows) objectPresent.set(String(r.name), r.present === true);
      }
    }
  } catch (e) {
    console.error(`verify-prod-migrations · DB query failed: ${(e && e.message) || e}`);
    process.exit(3);
  }

  const verdicts = NO_PROBE
    ? classify(fileVersions, applied, null)
    : classify(fileVersions, applied, objectPresent);

  const fileVersionSet = new Set(fileVersions.map((f) => f.version));
  const extra = [...applied].filter((v) => !fileVersionSet.has(v)).sort((a, b) => a - b);
  const hardFails = verdicts.filter((v) => HARD_FAIL.has(v.verdict));
  const warns = verdicts.filter((v) => WARN.has(v.verdict));

  if (JSON_OUT) {
    console.log(JSON.stringify({
      migration_files: fileVersions.length,
      recorded_applied: applied.size,
      probe: NO_PROBE ? 'skipped' : 'to_regclass',
      // BACKWARD-COMPAT: `missing` is consumed by predeploy-migration-gate.mjs
      // (`JSON.parse(...).missing.map(m => m.version)`). It now means "effectively
      // NOT applied" = the hard-fail set, which INCLUDES object-missing (ledger says
      // applied but the table is absent) — so the deploy gate now aborts on that
      // class too, via the field it already reads. `ledger-missing` (table present)
      // is deliberately NOT in `missing`: the object exists, deployed code won't 500.
      missing: hardFails.map((v) => ({ version: v.version, file: v.file, verdict: v.verdict })),
      hard_fail: hardFails.map((v) => ({ version: v.version, file: v.file, verdict: v.verdict, keyTable: v.keyTable })),
      warn: warns.map((v) => ({ version: v.version, file: v.file, verdict: v.verdict, keyTable: v.keyTable })),
      extra_recorded_no_file: extra,
      ok: hardFails.length === 0,
    }, null, 2));
  } else {
    log(`verify-prod-migrations · ${fileVersions.length} files · ${applied.size} recorded applied · probe=${NO_PROBE ? 'off' : 'to_regclass'}`);
    log('');
    const tag = { ok: 'OK     ', 'object-missing': 'FAIL·⊘', 'ledger-missing': 'WARN·ℓ', unapplied: 'MISSING', 'unapplied-noprobe': 'MISSING' };
    for (const v of verdicts) {
      const note = v.verdict === 'object-missing' ? '  (ledger says applied but TABLE ABSENT — live-500 risk)'
        : v.verdict === 'ledger-missing' ? '  (table present, ledger row absent — back-fill ledger)'
        : '';
      log(`  ${tag[v.verdict]}  ${String(v.version).padStart(3, '0')}  ${v.file}${note}`);
    }
    if (extra.length) { log(''); log(`  recorded but no file (renamed/deleted?): ${extra.join(', ')}`); }
    log('');
    if (hardFails.length) {
      log(`FAIL · ${hardFails.length} migration(s) not effectively applied on this DB:`);
      for (const v of hardFails) {
        log(`   - ${v.file}  [${v.verdict}]`);
        log(`       apply: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/workers/db/migrations/${v.file}`);
      }
    } else {
      log(`PASS · every migration is applied and its key object exists${warns.length ? ` (${warns.length} ledger back-fill WARN)` : ''}`);
    }
    if (warns.length) {
      log('');
      log(`WARN · ${warns.length} table(s) present but ledger row absent (benign; back-fill workers_schema_version):`);
      for (const v of warns) log(`   - ${v.file}  (table ${v.keyTable} exists)`);
    }
  }

  if (hardFails.length && !WARN_ONLY) process.exit(2);
  process.exit(0);
}

// Run main() only when executed as a CLI — importing { classify, parseKeyTable }
// for reuse/testing must not trigger the DB check or process.exit.
if (import.meta.url === `file://${process.argv[1]}`) main();
