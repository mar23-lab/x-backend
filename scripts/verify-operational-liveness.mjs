#!/usr/bin/env node
// scripts/verify-operational-liveness.mjs
//
// R54 · OPERATIONAL-LIVENESS gate (NEW gate class from the R50→R53 retro).
//
// The retro's meta-root-cause: every prior gate verified STRUCTURE (a file
// exists, a regex matches, a bundle contains a string) — none verified
// OPERATION (a migration actually applied on prod, a config row exists, the
// system can run). That's how migrations 009/010/011 sat "shipped" (authored +
// committed + gate-green) for ~2 days while ABSENT from production.
//
// This gate closes that hole. Two layers:
//   1. STRUCTURAL (always): the migration files exist + are version-gated.
//   2. LIVE (when DATABASE_URL is set): the schema is actually applied on the
//      target DB. Run against prod:
//        DATABASE_URL='postgres://…neon.tech/db?sslmode=require' \
//          node scripts/verify-operational-liveness.mjs
//
// Exit 0 if all run checks pass; 1 otherwise. LIVE is SKIPPED (not failed)
// when DATABASE_URL is absent, but prints a loud reminder — a green
// structural-only run must NEVER be mistaken for "live on prod".

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0, skipped = 0;
const failures = [];
async function gate(name, fn) {
  try {
    const ok = await fn();
    if (ok === true) { console.log(`  ☑ ${name}`); passed++; }
    else if (ok === 'skip') { console.log(`  ⊘ ${name} · SKIPPED`); skipped++; }
    else { console.log(`  ✗ ${name} · ${ok}`); failed++; failures.push({ name, reason: ok }); }
  } catch (e) {
    console.log(`  ✗ ${name} · threw ${e.message}`); failed++; failures.push({ name, reason: e.message });
  }
}

console.log('verify-operational-liveness · R54 gate\n');

const EXPECTED_MIGRATIONS = [
  { v: 9,  file: '009_lem_v4_inference_audit.sql' },
  { v: 10, file: '010_lem_v4_detector_config_seed.sql' },
  { v: 11, file: '011_personal_life_seed.sql' },
  { v: 12, file: '012_operator_layout.sql' },
  { v: 13, file: '013_operations_live_stream_snapshots.sql' },
];
for (const m of EXPECTED_MIGRATIONS) {
  await gate(`structural: ${m.file} exists + version-gated at ${m.v}`, async () => {
    const p = path.join(REPO, 'src/workers/db/migrations', m.file);
    if (!existsSync(p)) return 'file missing';
    const src = await fs.readFile(p, 'utf8');
    if (!new RegExp(`workers_schema_version WHERE version = ${m.v}\\b`).test(src)) return `not version-gated at ${m.v}`;
    return true;
  });
}

const DB_URL = process.env.DATABASE_URL;
const AUDIT_TABLES = ['detector_config','inference_runs','inference_signal_evals','inference_emissions','recommendation_rejections','calibration_buckets'];

if (!DB_URL) {
  await gate('LIVE: schema applied on target DB', async () => 'skip');
  console.log('\n  ⚠  LIVE checks SKIPPED — set DATABASE_URL to verify prod. A green');
  console.log('     structural-only run does NOT mean the schema is live on prod.');
} else {
  let sql;
  try {
    const mod = await import('@neondatabase/serverless');
    sql = mod.neon(DB_URL);
  } catch (e) {
    await gate('LIVE: connect to DB', async () => `cannot init neon client: ${e.message}`);
  }
  if (sql) {
    await gate('LIVE: schema versions superset of {9,10,11,12,13}', async () => {
      const rows = await sql`SELECT version FROM workers_schema_version ORDER BY version`;
      const have = new Set(rows.map((r) => Number(r.version)));
      const missing = [9,10,11,12,13].filter((v) => !have.has(v));
      return missing.length === 0 ? true : `missing applied versions: ${missing.join(',')}`;
    });
    await gate('LIVE: 6 LEM-v4 audit tables exist on prod', async () => {
      const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_name = ANY(${AUDIT_TABLES})`;
      return rows.length === 6 ? true : `only ${rows.length}/6 audit tables present`;
    });
    await gate('LIVE: an active detector_config exists (floors 2.5/3/2)', async () => {
      const rows = await sql`SELECT version_id, thresholds FROM detector_config WHERE deactivated_at IS NULL`;
      if (rows.length !== 1) return `expected exactly 1 active config, found ${rows.length}`;
      const t = rows[0].thresholds || {};
      if (Number(t.E_min) !== 2.5 || Number(t.DAD_min) !== 3 || Number(t.DDC_min) !== 2) {
        return `floors are ${t.E_min}/${t.DAD_min}/${t.DDC_min}, expected 2.5/3/2`;
      }
      return true;
    });
  }
}

console.log(`\nverify-operational-liveness · ${passed}/${passed + failed} passed · ${skipped} skipped`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name} · ${f.reason}`);
  process.exit(1);
}
process.exit(0);
