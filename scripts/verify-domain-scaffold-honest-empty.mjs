#!/usr/bin/env node
// scripts/verify-domain-scaffold-honest-empty.mjs · ABS-P3 — the honest-empty guard for the
// customer-provisioning domain-skeleton scaffold.
//
// RULE: the archetype registry (src/workers/services/domain-archetypes.ts) is Tier-B STRUCTURE ONLY.
// A domain skeleton carries identity (slug/label/kind) + a structural binding + provenance metadata —
// and NOTHING that fabricates content: no goals, metrics, roadmaps, recommendations, counts, targets,
// review cadences, or timestamps baked into the seed data. A scaffolded domain must be structurally
// present but EMPTY; the customer (or a governed agent) fills it. This gate fails if a fabricated-content
// KEY appears as data in the archetype module. Comments (which legitimately say "NEVER carries goals…")
// are exempt — only executable/data lines are scanned.
//
//   node scripts/verify-domain-scaffold-honest-empty.mjs             # gate
//   node scripts/verify-domain-scaffold-honest-empty.mjs --self-test  # prove the teeth bite

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const TARGET = 'src/workers/services/domain-archetypes.ts';

// Forbidden fabricated-content KEYS (as object keys `key:`), never allowed in the archetype seed data.
// binding/metadata/slug/label/kind/visibility/owner_user_id/workspace_id/filters/values are all fine.
const FORBIDDEN = [
  { id: 'goal-content', label: 'goals / goal counts', pattern: /\b(goals|goal_count|goal_metric_contract)\s*:/ },
  { id: 'metric-content', label: 'metrics / targets', pattern: /\b(metrics|metric_name|target_value|target_delta|current_baseline|current_value)\s*:/ },
  { id: 'roadmap-content', label: 'roadmaps', pattern: /\b(roadmap|roadmap_id|roadmap_items|has_roadmap)\s*:/ },
  { id: 'recommendation-content', label: 'recommendations', pattern: /\b(recommendations|open_recommendation_count)\s*:/ },
  { id: 'review-content', label: 'review cadence data', pattern: /\b(review_due|review_cadence)\s*:/ },
  { id: 'fabricated-timestamp', label: 'baked-in timestamps', pattern: /\b(created_at|updated_at|occurred_at)\s*:/ },
];

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Returns the list of {id,label} blockers a line trips (empty = clean). Comments never trip. */
export function scanLine(line) {
  if (isCommentLine(line)) return [];
  return FORBIDDEN.filter((b) => b.pattern.test(line)).map((b) => ({ id: b.id, label: b.label }));
}

export function runChecks(src) {
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    for (const hit of scanLine(line)) {
      offenders.push(`${TARGET}:${i + 1}  [${hit.id}] ${line.trim().slice(0, 100)}`);
    }
  });
  return offenders;
}

function selfTest() {
  let failures = 0;
  const expect = (name, cond) => { if (!cond) { failures++; console.log(`  ✗ self-test ${name}`); } else console.log(`  ☑ self-test ${name}`); };
  const realSrc = fs.readFileSync(path.join(repoRoot, TARGET), 'utf8');
  expect('real-module-clean', runChecks(realSrc).length === 0);
  expect('goal-count-bites', scanLine(`      { slug: 'career', label: 'Career', kind: 'life', goal_count: 3 },`).length > 0);
  expect('metrics-bites', scanLine(`      metrics: [{ metric_name: 'ARR', target_value: 100000 }],`).length > 0);
  expect('roadmap-bites', scanLine(`      has_roadmap: true,`).length > 0);
  expect('timestamp-bites', scanLine(`      created_at: '2026-07-13',`).length > 0);
  // structural keys are clean
  expect('slug-clean', scanLine(`      { slug: 'operations', label: 'Operations', kind: 'company' },`).length === 0);
  expect('metadata-clean', scanLine(`    metadata: { scaffolded_by: 'domain-archetype-scaffold', archetype: archetypeKey },`).length === 0);
  // a comment mentioning goals/metrics does NOT bite
  expect('comment-clean', scanLine(`  // NEVER carries goals, metrics, roadmaps, or recommendations.`).length === 0);
  console.log(failures === 0 ? '\n☑ self-test all teeth bite' : `\n✗ ${failures} self-test failure(s)`);
  return failures === 0 ? 0 : 1;
}

function main() {
  console.log('verify-domain-scaffold-honest-empty · ABS-P3');
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  const target = path.join(repoRoot, TARGET);
  if (!fs.existsSync(target)) {
    console.log(`  ☑ ${TARGET} absent — nothing to scan (scaffold not yet built)`);
    process.exit(0);
  }
  const offenders = runChecks(fs.readFileSync(target, 'utf8'));
  if (offenders.length > 0) {
    console.log(`\n✗ ${offenders.length} fabricated-content key(s) in the archetype registry — skeletons must be STRUCTURE ONLY (slug/label/kind):`);
    for (const o of offenders) console.log(`  ${o}`);
    process.exit(1);
  }
  console.log('  ☑ archetype domain skeletons are honest-empty (no goals/metrics/roadmaps/timestamps baked in)');
  console.log('\n☑ domain-scaffold-honest-empty holds');
  process.exit(0);
}

main();
