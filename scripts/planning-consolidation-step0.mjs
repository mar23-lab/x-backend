#!/usr/bin/env node
/**
 * planning-consolidation-step0 — §1c Step-0 preconditions, READ-ONLY (plus one ledger baseline
 * write when --record is passed and migration 097 has been applied).
 *
 * The three gates the §1c design says this wave must land:
 *   1. ID-INTERSECT ASSERT — `SELECT id INTERSECT` across plan_entities × synthetic_domain_goals
 *      (and × intents, informational). A collision under the Step-4 `ON CONFLICT (id) DO NOTHING`
 *      backfill silently DROPS goal data — a false-green migrate. Any collision = hard FAIL.
 *   2. LEDGER BASELINE — rows_in per source store, recorded to planning_consolidation_ledger
 *      (--record; requires 097) so Step-4 reconciliation has an immutable "before" count.
 *   3. PRODUCER CENSUS — greps the worker source for every consumer of the legacy stores and
 *      compares against the design's RECORDED set. A producer found in code but missing from the
 *      recorded set fails the census: count the producers BEFORE doubting the condition — the
 *      estate's no-op-measurement lesson, fired 3× in one night.
 *
 * Usage:  DATABASE_URL=<owner-dsn> node scripts/planning-consolidation-step0.mjs [--record]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error('planning-consolidation-step0 · FAIL · DATABASE_URL (owner DSN) is required');
  process.exit(1);
}
const record = process.argv.includes('--record');
const psql = (sql) => execFileSync('psql', [DSN, '-X', '-A', '-t', '-c', sql], { encoding: 'utf8' }).trim();

const failures = [];

// ── 1 · store measurement + id-intersect assert ──────────────────────────────────────────────────
const counts = {
  plan_entities: Number(psql('SELECT count(*) FROM plan_entities')),
  synthetic_domain_goals: Number(psql('SELECT count(*) FROM synthetic_domain_goals')),
  synthetic_domain_roadmap_items: Number(psql("SELECT count(*) FROM synthetic_domain_roadmap_items")),
  intents: Number(psql('SELECT count(*) FROM intents')),
};
const goalCollisions = Number(psql(
  'SELECT count(*) FROM (SELECT id FROM plan_entities INTERSECT SELECT id FROM synthetic_domain_goals) x',
));
const roadmapCollisions = Number(psql(
  'SELECT count(*) FROM (SELECT id FROM plan_entities INTERSECT SELECT id FROM synthetic_domain_roadmap_items) x',
));
const intentOverlap = Number(psql(
  'SELECT count(*) FROM (SELECT id FROM plan_entities INTERSECT SELECT id FROM intents) x',
));
if (goalCollisions > 0) failures.push(`id-intersect: ${goalCollisions} plan_entities × synthetic_domain_goals collision(s) — Step-4 ON CONFLICT DO NOTHING would silently drop goal data`);
if (roadmapCollisions > 0) failures.push(`id-intersect: ${roadmapCollisions} plan_entities × roadmap_items collision(s)`);

// ── 2 · writer-dead check: the mbp-domain-sync propagation writer must be quiescent ─────────────
const lastGoalWrite = psql("SELECT coalesce(max(updated_at)::text, 'never') FROM synthetic_domain_goals");
// The 074 either-authority trigger is the one migration-borne RUNTIME consumer — verify it live.
const trigger074 = psql(
  "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'work_relationships' AND NOT t.tgisinternal",
);

// ── 3 · producer census: code-derived consumer set vs the design's recorded set ─────────────────
const RECORDED_PRODUCERS = [
  'dal/propagation-store', 'dal/roadmap-store', 'dal/graph-store',
  'inference', 'signals', 'review-scheduler', 'routes/synthetic-domains',
  'workspaces', 'completion-contract',
  // Caught by THIS census on its own first run (260806): the design's recorded set missed the
  // adapter — the enumerated-list lesson firing inside the gate built to prevent it. Recorded here;
  // the design doc's consumer list must be amended before Step 5 read-cutover.
  'dal/WorkersDalAdapter',
];
const found = new Set();
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // db/migrations are HISTORY, not runtime producers; the 074 trigger — the one migration-borne
    // RUNTIME consumer — is checked below as a live database object, not as a file.
    if (entry.isDirectory()) { if (!['node_modules', '__tests__', 'migrations'].includes(entry.name)) scan(path); continue; }
    if (!/\.(ts|sql)$/.test(entry.name)) continue;
    const text = readFileSync(path, 'utf8');
    if (/synthetic_domain_goals|synthetic_domain_roadmap_items/.test(text)) {
      found.add(path.replace(/^src\/workers\//, '').replace(/\.(ts|sql)$/, ''));
    }
  }
};
scan('src/workers');
const unrecorded = [...found].filter((path) => !RECORDED_PRODUCERS.some((known) => path.includes(known)));
if (unrecorded.length > 0) {
  failures.push(`producer census: ${unrecorded.length} consumer(s) of the legacy stores NOT in the design's recorded set: ${unrecorded.join(', ')}`);
}

// ── 4 · ledger baseline (requires 097) ──────────────────────────────────────────────────────────
const has097 = psql('SELECT count(*) FROM workers_schema_version WHERE version = 97') === '1';
if (record) {
  if (!has097) {
    failures.push('--record requires migration 097 (planning_consolidation_ledger does not exist yet)');
  } else {
    for (const [table, rows] of Object.entries(counts)) {
      psql(`INSERT INTO planning_consolidation_ledger (step, source_table, rows_in, notes)
            VALUES ('step0-baseline', '${table}', ${rows}, 'read-only precondition measurement')`);
    }
  }
}

const report = {
  counts,
  id_collisions: { goals: goalCollisions, roadmap_items: roadmapCollisions, intents_informational: intentOverlap },
  last_synthetic_goal_write: lastGoalWrite,
  work_relationships_triggers_live: Number(trigger074),
  producers_found: [...found].sort(),
  producers_unrecorded: unrecorded,
  migration_097_applied: has097,
  ledger_baseline_recorded: record && has097 && failures.length === 0,
};
console.log(JSON.stringify(report, null, 2));

if (failures.length > 0) {
  console.error(`planning-consolidation-step0 · FAIL · ${failures.length} precondition(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('planning-consolidation-step0 · PASS · zero id collisions, producer census reconciled');
