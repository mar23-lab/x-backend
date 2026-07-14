#!/usr/bin/env node
// scripts/verify-lem-v4-migrations.mjs
//
// R51-γ (Wave γ) ci-local gate · Federated-waterfall plan §"Anti-pattern
// retirement schedule" row "Inference framework defined in markdown only".
//
// What this gate proves
// ---------------------
// 1. Migrations 009/010/011 SQL files exist at the expected paths.
// 2. Migration 009 creates all 6 LEM-v4 audit tables (detector_config,
//    inference_runs, inference_signal_evals, inference_emissions,
//    recommendation_rejections, calibration_buckets) + ALTERs the existing
//    synthetic_domain_recommendations table.
// 3. Migration 010 seeds detector_config with the 14-signal taxonomy +
//    operating-default thresholds.
// 4. Migration 011 seeds 6 personal-life-domain roots in mbp-private.
// 5. DAL types barrel exposes the 6 entity shapes + 5 input shapes.
// 6. DalAdapter.ts interface has the 10 new method signatures.
// 7. WorkersDalAdapter.ts has the getActiveDetectorConfig impl + 9
//    NOT_IMPLEMENTED_IN_GAMMA stubs.
//
// Why this is structural-only:
//   Dynamic exercise would require a live Neon connection. Migrations are
//   verified at apply-time in production (wrangler d1 migrations list +
//   workers_schema_version table). This gate guards the source-tree shape
//   so the build doesn't ship broken SQL or untyped DAL signatures.
//
// Exit code: 0 if all gates pass, 1 otherwise.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

let passed = 0;
let failed = 0;
const failures = [];

async function gate(name, fn) {
  try {
    const ok = await fn();
    if (ok === true) {
      console.log(`  ☑ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name} · ${typeof ok === 'string' ? ok : 'falsy'}`);
      failed++;
      failures.push({ name, reason: typeof ok === 'string' ? ok : 'falsy' });
    }
  } catch (err) {
    console.log(`  ✗ ${name} · ${err && err.message ? err.message : String(err)}`);
    failed++;
    failures.push({ name, reason: err && err.message ? err.message : String(err) });
  }
}

console.log('verify-lem-v4-migrations · R51-γ (Wave γ) gate\n');

// ── Gate 1: migration files present ────────────────────────────────────
await gate('R51-γ-1: migration 009 (LEM-v4 audit) exists', async () => {
  const p = path.join(REPO_ROOT, 'src/workers/db/migrations/009_lem_v4_inference_audit.sql');
  return existsSync(p) ? true : `missing: ${p}`;
});

await gate('R51-γ-1: migration 010 (detector_config genesis seed) exists', async () => {
  const p = path.join(REPO_ROOT, 'src/workers/db/migrations/010_lem_v4_detector_config_seed.sql');
  return existsSync(p) ? true : `missing: ${p}`;
});

await gate('R51-γ-1: migration 011 (personal-life seed) exists', async () => {
  const p = path.join(REPO_ROOT, 'src/workers/db/migrations/011_personal_life_seed.sql');
  return existsSync(p) ? true : `missing: ${p}`;
});

// ── Gate 2: migration 009 creates all 6 audit tables + ALTER ──────────
await gate('R51-γ-1: migration 009 creates all 6 LEM-v4 audit tables', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/db/migrations/009_lem_v4_inference_audit.sql'),
    'utf8',
  );
  const required = [
    'CREATE TABLE detector_config',
    'CREATE TABLE inference_runs',
    'CREATE TABLE inference_signal_evals',
    'CREATE TABLE inference_emissions',
    'CREATE TABLE recommendation_rejections',
    'CREATE TABLE calibration_buckets',
  ];
  for (const r of required) {
    if (!src.includes(r)) return `missing: ${r}`;
  }
  // workers_schema_version guard
  if (!/workers_schema_version WHERE version = 9/.test(src)) return 'missing version=9 guard';
  // Single-active enforcement on detector_config
  if (!/uq_detector_config_active/.test(src)) return 'missing partial unique index on active detector_config';
  // FK from emissions → existing recommendations table
  if (!/REFERENCES synthetic_domain_recommendations\(id\)/.test(src)) {
    return 'inference_emissions missing FK to synthetic_domain_recommendations';
  }
  // ALTER to add 4 LEM-v4 columns to existing recommendations
  const alterCols = [
    'ADD COLUMN evidence_score',
    'ADD COLUMN composite_confidence',
    'ADD COLUMN pattern_fingerprint',
    'ADD COLUMN signal_contribution_breakdown',
    'ADD COLUMN detector_config_version_id',
  ];
  for (const c of alterCols) {
    if (!src.includes(c)) return `missing ALTER: ${c}`;
  }
  return true;
});

// ── Gate 3: migration 010 seeds genesis detector_config ───────────────
await gate('R51-γ-2: migration 010 seeds dcv_r50_genesis_v1 with all 14 signals', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/db/migrations/010_lem_v4_detector_config_seed.sql'),
    'utf8',
  );
  if (!/'dcv_r50_genesis_v1'/.test(src)) return 'missing dcv_r50_genesis_v1';
  // All 14 signals must appear in both weights and signal_names array
  const signals = [
    'actor_co_occurrence', 'temporal_co_occurrence', 'artifact_cross_reference',
    'sequence_pattern', 'dwell_concentration', 'keyword_co_occurrence',
    'intent_keyword_density', 'tag_overlap', 'embedding_similarity',
    'parent_distance', 'membership_overlap', 'actor_jaccard',
    'stated_goal_keyword_overlap', 'rollup_alignment',
  ];
  for (const s of signals) {
    if (!src.includes(s)) return `missing signal: ${s}`;
  }
  // Threshold defaults per §16.4.2
  const thresholds = [
    '"E_min":', '"DAD_min":', '"DDC_min":', '"composite_confidence_min":',
    '"lookback_window_days":', '"cooldown_window_days":', '"precision_target":',
    '"precision_floor":', '"calibration_error_retune_trigger":',
    '"cooccurrence_bucket_B_hours":',
  ];
  for (const t of thresholds) {
    if (!src.includes(t)) return `missing threshold: ${t}`;
  }
  // embedding_similarity must be 0 per §16.2 STUBBED note
  if (!/"embedding_similarity":\s+0\.00/.test(src)) {
    return 'embedding_similarity must be 0 (R50 stub per §16.2)';
  }
  if (!/workers_schema_version WHERE version = 10/.test(src)) return 'missing version=10 guard';
  return true;
});

// ── Gate 4: migration 011 seeds 6 life domains ────────────────────────
await gate('R51-γ-3: migration 011 seeds 6 personal-life domains in mbp-private', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/db/migrations/011_personal_life_seed.sql'),
    'utf8',
  );
  const required = [
    "'sd_seed_mbp_health'", "'sd_seed_mbp_finance'", "'sd_seed_mbp_family'",
    "'sd_seed_mbp_work'", "'sd_seed_mbp_learning'", "'sd_seed_mbp_creative'",
  ];
  for (const r of required) {
    if (!src.includes(r)) return `missing seed: ${r}`;
  }
  // All in mbp-private workspace
  const occurrences = (src.match(/'mbp-private'/g) || []).length;
  if (occurrences < 6) return `'mbp-private' appears ${occurrences} times, expected ≥ 6`;
  // All marked is_pre_accepted_root=true so detector excludes them
  if (!/"is_pre_accepted_root":true/.test(src)) {
    return 'missing is_pre_accepted_root metadata';
  }
  // visibility = operator_only (these are operator-only baseline roots)
  const operatorOnlyCount = (src.match(/'operator_only'/g) || []).length;
  if (operatorOnlyCount < 6) {
    return `'operator_only' appears ${operatorOnlyCount} times, expected ≥ 6`;
  }
  if (!/workers_schema_version WHERE version = 11/.test(src)) return 'missing version=11 guard';
  return true;
});

// ── Gate 5: DAL types ──────────────────────────────────────────────────
await gate('R51-γ-2: types barrel exposes 6 LEM-v4 entity shapes + 5 input shapes', async () => {
  const barrel = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/dal/types.ts'),
    'utf8',
  );
  const inference = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/dal/types/inference.ts'),
    'utf8',
  );
  if (!barrel.includes("export * from './types/inference'")) {
    return 'types.ts barrel must re-export ./types/inference';
  }
  const src = `${barrel}\n${inference}`;
  const required = [
    'export interface DetectorConfig',
    'export interface InferenceRun',
    'export interface InferenceEmission',
    'export interface RecommendationRejection',
    'export interface CalibrationBucket',
    'export interface InferenceRunInput',
    'export interface InferenceRunCompletion',
    'export interface InferenceSignalEvalInput',
    'export interface InferenceEmissionInput',
    'export interface RecommendationRejectionInput',
    'export interface CalibrationBucketUpsertInput',
    'export type InferenceRunKind',
    'export type InferenceRunStatus',
    'export type RejectionTaxonomy',
  ];
  for (const r of required) {
    if (!src.includes(r)) return `missing type: ${r}`;
  }
  return true;
});

// ── Gate 6: DalAdapter interface + WorkersDalAdapter impl ─────────────
await gate('R51-γ-2: DalAdapter interface declares 10 LEM-v4 methods', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/dal/DalAdapter.ts'),
    'utf8',
  );
  const required = [
    'getActiveDetectorConfig(',
    'insertDetectorConfig(',
    'insertInferenceRun(',
    'completeInferenceRun(',
    'bulkInsertInferenceSignalEvals(',
    'insertInferenceEmission(',
    'listInferenceEmissionsForRun(',
    'insertRecommendationRejection(',
    'countRecommendationRejectionsForFingerprint(',
    'upsertCalibrationBucket(',
  ];
  for (const r of required) {
    if (!src.includes(r)) return `missing signature: ${r}`;
  }
  return true;
});

await gate('R51-γ-2: WorkersDalAdapter implements getActiveDetectorConfig + 9 NOT_IMPLEMENTED stubs', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/dal/WorkersDalAdapter.ts'),
    'utf8',
  );
  if (!/async getActiveDetectorConfig\(\)/.test(src)) return 'getActiveDetectorConfig impl missing';
  if (!/FROM detector_config\s+WHERE deactivated_at IS NULL/i.test(src)) {
    return 'getActiveDetectorConfig must read active row';
  }
  // 9 stub methods must use the helper
  const stubMethods = [
    'insertDetectorConfig', 'insertInferenceRun', 'completeInferenceRun',
    'bulkInsertInferenceSignalEvals', 'insertInferenceEmission',
    'listInferenceEmissionsForRun', 'insertRecommendationRejection',
    'countRecommendationRejectionsForFingerprint', 'upsertCalibrationBucket',
  ];
  for (const m of stubMethods) {
    const re = new RegExp(`${m}\\([^)]*\\)\\s*\\{\\s*\\n[\\s\\S]*?NOT_IMPLEMENTED_IN_GAMMA`);
    if (!re.test(src)) return `${m} missing NOT_IMPLEMENTED_IN_GAMMA stub`;
  }
  // Helper itself exists and produces 501 errors
  if (!/function NOT_IMPLEMENTED_IN_GAMMA\(/.test(src)) return 'NOT_IMPLEMENTED_IN_GAMMA helper missing';
  if (!/NOT_IMPLEMENTED_IN_WAVE_GAMMA/.test(src)) return 'error code NOT_IMPLEMENTED_IN_WAVE_GAMMA missing';
  return true;
});

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\nverify-lem-v4-migrations · ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name} · ${f.reason}`);
  }
  process.exit(1);
}
process.exit(0);
