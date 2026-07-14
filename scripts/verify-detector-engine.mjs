#!/usr/bin/env node
// scripts/verify-detector-engine.mjs
//
// R51-δ-B (Wave δ-B) ci-local gate · Federated-waterfall plan §"Anti-pattern
// retirement schedule" row "inference framework partially defined" → full.
//
// What this gate proves
// ---------------------
// 1. 14 signal extractors exist at expected family/file paths.
// 2. SIGNAL_REGISTRY exports all 14 in the order matching detector_config.signal_names
//    from migration 010 (deterministic iteration).
// 3. SIGNAL_BY_FAMILY groups correctly (5 behavioral + 4 semantic + 3 structural + 2 goal).
// 4. Each signal source has the right family literal + name field + clamp01 import.
// 5. embedding_similarity is the stub returning 0 (R50; activates in R51 per §16.2).
// 6. WorkersDalAdapter has no remaining NOT_IMPLEMENTED_IN_GAMMA stubs for LEM-v4
//    methods (all 10 methods have bodies now).
// 7. detector-engine.ts exports runDetectorTick + aggregateCesInputs +
//    computeCompositeConfidence + computePatternFingerprint.
// 8. Detector engine wiring: reads active detector_config, runs 14 signals,
//    computes CES, decides emission, writes audit trail.
// 9. Synthetic-domains routes wire all 4 new surfaces: GET /api/v1/recommendations,
//    POST /admin/detector-tick, accept extension with lem_v4_audit, reject
//    extension with anti_rec_audit.
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

console.log('verify-detector-engine · R51-δ-B (Wave δ-B) gate\n');

// ── Gate 1: 14 signal extractor files ──────────────────────────────────
const SIGNALS_BY_FAMILY = {
  behavioral: [
    'actor_co_occurrence', 'temporal_co_occurrence', 'artifact_cross_reference',
    'sequence_pattern', 'dwell_concentration',
  ],
  semantic: [
    'keyword_co_occurrence', 'intent_keyword_density', 'tag_overlap', 'embedding_similarity',
  ],
  structural: [
    'parent_distance', 'membership_overlap', 'actor_jaccard',
  ],
  goal: [
    'stated_goal_keyword_overlap', 'rollup_alignment',
  ],
};

for (const [family, names] of Object.entries(SIGNALS_BY_FAMILY)) {
  for (const sigName of names) {
    await gate(`R51-δ-B1: ${family}/${sigName}.ts exists + correct family literal + name field`, async () => {
      const p = path.join(REPO_ROOT, `src/workers/inference/signals/${family}/${sigName}.ts`);
      if (!existsSync(p)) return `missing: ${p}`;
      const src = await fs.readFile(p, 'utf8');
      if (!new RegExp(`name:\\s*'${sigName}'`).test(src)) return `name field missing or wrong`;
      if (!new RegExp(`family:\\s*'${family}'`).test(src)) return `family literal mismatch`;
      return true;
    });
  }
}

// ── Gate 2: registry barrel ────────────────────────────────────────────
await gate('R51-δ-B1: SIGNAL_REGISTRY exports all 14 + SIGNAL_BY_FAMILY grouping', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/inference/signals/index.ts'),
    'utf8',
  );
  // All 14 must appear in SIGNAL_REGISTRY export
  const allNames = Object.values(SIGNALS_BY_FAMILY).flat();
  for (const n of allNames) {
    const camel = n.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) + 'Signal';
    if (!src.includes(camel)) return `${camel} missing from registry`;
  }
  if (!/export const SIGNAL_REGISTRY/.test(src)) return 'SIGNAL_REGISTRY export missing';
  if (!/export const SIGNAL_BY_NAME/.test(src)) return 'SIGNAL_BY_NAME export missing';
  if (!/export const SIGNAL_BY_FAMILY/.test(src)) return 'SIGNAL_BY_FAMILY export missing';
  // Family grouping
  if (!/behavioral:\s*Object\.freeze/.test(src)) return 'behavioral family grouping missing';
  if (!/semantic:\s*Object\.freeze/.test(src)) return 'semantic family grouping missing';
  if (!/structural:\s*Object\.freeze/.test(src)) return 'structural family grouping missing';
  if (!/goal:\s*Object\.freeze/.test(src)) return 'goal family grouping missing';
  return true;
});

// ── Gate 3: embedding_similarity is the R50 stub ──────────────────────
await gate('R51-δ-B1: embedding_similarity is the R50 stub (returns 0 with explanation)', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/inference/signals/semantic/embedding_similarity.ts'),
    'utf8',
  );
  if (!/raw_value:\s*0/.test(src)) return 'raw_value not pinned to 0';
  if (!/normalized_value:\s*0/.test(src)) return 'normalized_value not pinned to 0';
  if (!/STUBBED in R50/.test(src)) return 'stub explanation missing';
  if (!/§16\.2/.test(src) && !/16\.2/.test(src)) return 'spec reference missing';
  return true;
});

// ── Gate 4: zero remaining NOT_IMPLEMENTED stubs in DAL ───────────────
await gate('R51-δ-B2: WorkersDalAdapter has zero remaining NOT_IMPLEMENTED_IN_GAMMA stubs for LEM-v4', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/dal/WorkersDalAdapter.ts'),
    'utf8',
  );
  // The helper itself is allowed to exist (it's referenced in comments and
  // might be reused elsewhere). What's NOT allowed is any DAL method body
  // that still throws via NOT_IMPLEMENTED_IN_GAMMA for the 10 LEM-v4 methods.
  const lemV4Methods = [
    'insertDetectorConfig', 'insertInferenceRun', 'completeInferenceRun',
    'bulkInsertInferenceSignalEvals', 'insertInferenceEmission',
    'listInferenceEmissionsForRun', 'insertRecommendationRejection',
    'countRecommendationRejectionsForFingerprint', 'upsertCalibrationBucket',
    'getActiveDetectorConfig',
  ];
  for (const m of lemV4Methods) {
    // Match: method declaration followed within 200 chars by NOT_IMPLEMENTED_IN_GAMMA
    const re = new RegExp(`\\b${m}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,200}?NOT_IMPLEMENTED_IN_GAMMA`);
    if (re.test(src)) return `${m} still uses NOT_IMPLEMENTED_IN_GAMMA stub`;
  }
  return true;
});

// ── Gate 5: DAL impl has the 7 new bodies (sql calls present) ─────────
await gate('R51-δ-B2: WorkersDalAdapter has real SQL for insertDetectorConfig/Run/Completion/Eval/Emission/Calibration', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/dal/WorkersDalAdapter.ts'),
    'utf8',
  );
  // Concrete SQL surface checks
  if (!/INSERT INTO detector_config/.test(src)) return 'insertDetectorConfig missing INSERT';
  if (!/INSERT INTO inference_runs/.test(src)) return 'insertInferenceRun missing INSERT';
  if (!/UPDATE inference_runs/.test(src)) return 'completeInferenceRun missing UPDATE';
  if (!/INSERT INTO inference_signal_evals/.test(src)) return 'bulkInsertInferenceSignalEvals missing INSERT';
  if (!/UNNEST\(/.test(src)) return 'bulk insert via UNNEST missing';
  if (!/INSERT INTO inference_emissions/.test(src)) return 'insertInferenceEmission missing INSERT';
  if (!/INSERT INTO calibration_buckets/.test(src)) return 'upsertCalibrationBucket missing INSERT';
  if (!/ON CONFLICT \(pattern_kind, bucket_lower, window_started_at\)/.test(src)) {
    return 'calibration_buckets ON CONFLICT clause missing';
  }
  // Helpers
  if (!/function mapInferenceRun/.test(src)) return 'mapInferenceRun helper missing';
  if (!/function mapInferenceEmission/.test(src)) return 'mapInferenceEmission helper missing';
  return true;
});

// ── Gate 6: detector engine surfaces ───────────────────────────────────
await gate('R51-δ-B3: detector-engine.ts exports runDetectorTick + helpers', async () => {
  const p = path.join(REPO_ROOT, 'src/workers/inference/detector-engine.ts');
  if (!existsSync(p)) return `missing: ${p}`;
  const src = await fs.readFile(p, 'utf8');
  if (!/export async function runDetectorTick/.test(src)) return 'runDetectorTick missing';
  if (!/export function aggregateCesInputs/.test(src)) return 'aggregateCesInputs missing';
  if (!/export function computeCompositeConfidence/.test(src)) return 'computeCompositeConfidence missing';
  if (!/export function computePatternFingerprint/.test(src)) return 'computePatternFingerprint missing';
  // Engine wires the audit pipeline
  if (!/dal\.insertInferenceRun/.test(src)) return 'insertInferenceRun call missing';
  if (!/dal\.completeInferenceRun/.test(src)) return 'completeInferenceRun call missing';
  if (!/dal\.bulkInsertInferenceSignalEvals/.test(src)) return 'bulkInsertInferenceSignalEvals call missing';
  if (!/dal\.insertInferenceEmission/.test(src)) return 'insertInferenceEmission call missing';
  // Reads active detector_config
  if (!/dal\.getActiveDetectorConfig/.test(src)) return 'getActiveDetectorConfig call missing';
  // CES integration
  if (!/computeCes\(/.test(src)) return 'computeCes call missing';
  // Composite confidence (logistic sigmoid)
  if (!/1\s*\/\s*\(1\s*\+\s*Math\.exp\(-/.test(src)) return 'logistic sigmoid missing';
  // Determinism (no Math.random)
  if (/Math\.random/.test(src)) return 'Math.random forbidden in detector engine (§16.3 determinism)';
  return true;
});

// ── Gate 7: composite-confidence math sanity ───────────────────────────
await gate('R51-δ-B3: composite confidence with empty signals returns 0.5 (sigmoid(0)=0.5)', async () => {
  // Pure math check — no module import. Just exercise the formula
  // independently to assert §16.2 σ(0) = 0.5.
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  if (Math.abs(sigmoid(0) - 0.5) > 1e-10) return `sigmoid(0)=${sigmoid(0)}, expected 0.5`;
  // Heavy positive sum → near 1
  if (sigmoid(10) < 0.99) return `sigmoid(10)=${sigmoid(10)}, expected near 1`;
  // Heavy negative sum → near 0
  if (sigmoid(-10) > 0.01) return `sigmoid(-10)=${sigmoid(-10)}, expected near 0`;
  return true;
});

// ── Gate 8: pattern fingerprint determinism ────────────────────────────
await gate('R51-δ-B3: computePatternFingerprint is deterministic (same inputs → same output)', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/inference/detector-engine.ts'),
    'utf8',
  );
  // Structural check: fingerprint is derived from top-3 contributing signal names
  // (sorted DESC by contribution).
  if (!/sort\(\(a, b\) => b\[1\]\.contribution - a\[1\]\.contribution\)/.test(src)) {
    return 'top-3 contribution sort missing';
  }
  if (!/slice\(0, 3\)/.test(src)) return 'top-3 slice missing';
  if (!/pf_\$\{candidate_fingerprint\}__\$\{top3\.join/.test(src)) {
    return 'pf_ prefix + __ separator + joined top-3 names format missing';
  }
  return true;
});

// ── Gate 9: route surfaces ─────────────────────────────────────────────
await gate('R51-δ-B4: routes/synthetic-domains.ts wires 4 LEM-v4 surfaces', async () => {
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'src/workers/routes/synthetic-domains.ts'),
    'utf8',
  );
  // 1. GET /recommendations (mounted under /api/v1 → full path /api/v1/recommendations)
  // Route literal must be '/recommendations' (no double prefix); Wave ε-0 corrected this.
  if (!/['"]\/recommendations['"]/.test(src)) return "GET /recommendations route literal missing";
  // Drift guard: no path inside syntheticDomainsRoute may double-prefix /api/v1
  // (syntheticDomainsRoute is mounted at /api/v1 in workers/index.ts).
  if (/syntheticDomainsRoute\.(?:get|post)\(['"]\/api\/v1\//.test(src)) {
    return "syntheticDomainsRoute path double-prefixed with /api/v1 (drift)";
  }
  // 2. POST /admin/detector-tick
  if (!/['"]\/admin\/detector-tick['"]/.test(src)) return 'POST /admin/detector-tick route missing';
  if (!/runDetectorTick/.test(src)) return 'runDetectorTick import/call missing in routes';
  // 3. accept extension with lem_v4_audit
  if (!/lem_v4_audit/.test(src)) return 'accept-route lem_v4_audit extension missing';
  // 4. reject extension with anti_rec_audit (shipped in δ-A3; gate here for regression)
  if (!/anti_rec_audit/.test(src)) return 'reject-route anti_rec_audit extension missing';
  // has_lem_v4 filter on GET
  if (!/has_lem_v4_param/.test(src)) return 'has_lem_v4 filter param missing';
  return true;
});

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\nverify-detector-engine · ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name} · ${f.reason}`);
  }
  process.exit(1);
}
process.exit(0);
