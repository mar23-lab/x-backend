#!/usr/bin/env node
// verify-prod-migrations.mjs · 2026-06-07
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
//   Both were the two most-recent migrations; the manual step had skipped them.
//
// WHAT IT DOES
//   Compares src/workers/db/migrations/NNN_*.sql against the
//   workers_schema_version table and FAILS if any migration file is not
//   recorded as applied. Run it in CI and before shipping anything that depends
//   on a recent migration.
//
// USAGE
//   DATABASE_URL=postgres://... node scripts/verify-prod-migrations.mjs
//   node scripts/verify-prod-migrations.mjs            # (no DB) lists files, exits 1
//
// FLAGS
//   --warn-only   exit 0 even if gaps found (default: exit 2 on gaps)
//   --json        emit machine-readable JSON
//
// EXIT CODES
//   0  every migration file is recorded as applied (or --warn-only)
//   1  missing DATABASE_URL or migrations dir unreadable
//   2  gap(s): migration file(s) not recorded as applied
//   3  DB connection / query failed

import { neon } from '@neondatabase/serverless';
import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../src/workers/db/migrations');
const argv = process.argv.slice(2);
const WARN_ONLY = argv.includes('--warn-only');
const JSON_OUT = argv.includes('--json');
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

function parseFileVersions() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ version: parseInt(f.match(/^(\d+)_/)[1], 10), file: f }))
    .sort((a, b) => a.version - b.version);
}

async function main() {
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

  if (!process.env.DATABASE_URL) {
    log(`verify-prod-migrations · ${fileVersions.length} migration files found:`);
    for (const f of fileVersions) log(`   ${String(f.version).padStart(3, '0')}  ${f.file}`);
    log('');
    log('Set DATABASE_URL to compare against workers_schema_version on the target DB.');
    if (JSON_OUT) console.log(JSON.stringify({
      error: 'DATABASE_URL not set',
      files: fileVersions,
      ok: false,
      warn_only: WARN_ONLY,
    }, null, 2));
    process.exit(WARN_ONLY ? 0 : 1);
  }

  let applied;
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`SELECT version FROM workers_schema_version ORDER BY version`;
    applied = new Set(rows.map((r) => Number(r.version)));
  } catch (e) {
    console.error(`verify-prod-migrations · DB query failed: ${(e && e.message) || e}`);
    process.exit(3);
  }

  const fileVersionSet = new Set(fileVersions.map((f) => f.version));
  const missing = fileVersions.filter((f) => !applied.has(f.version));
  const extra = [...applied].filter((v) => !fileVersionSet.has(v)).sort((a, b) => a - b);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      migration_files: fileVersions.length,
      recorded_applied: applied.size,
      missing: missing.map((m) => ({ version: m.version, file: m.file })),
      extra_recorded_no_file: extra,
      ok: missing.length === 0,
    }, null, 2));
  } else {
    log(`verify-prod-migrations · ${fileVersions.length} files · ${applied.size} recorded as applied`);
    log('');
    for (const f of fileVersions) {
      log(`  ${applied.has(f.version) ? 'OK     ' : 'MISSING'}  ${String(f.version).padStart(3, '0')}  ${f.file}`);
    }
    if (extra.length) {
      log('');
      log(`  recorded but no file (renamed/deleted?): ${extra.join(', ')}`);
    }
    log('');
    if (missing.length) {
      log(`FAIL · ${missing.length} migration(s) NOT recorded as applied on this DB:`);
      for (const m of missing) {
        log(`   - ${m.file}`);
        log(`       apply: psql "$DATABASE_URL" -f src/workers/db/migrations/${m.file}`);
      }
    } else {
      log('PASS · every migration file is recorded as applied');
    }
  }

  if (missing.length && !WARN_ONLY) process.exit(2);
  process.exit(0);
}

main();
