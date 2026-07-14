// src/workers/inference/signals/goal/rollup_alignment.ts
//
// R51-δ-B1 · Signal 14 of 14 (Goal) — `rollup_alignment`.
//
// §16.2: "Drift score between rollup-form goals (derived) and intent-form
// goals (authored) — high drift is a strong synthetic-domain signal because
// it indicates the rollup needs its own surface."
//
// Intuition
// ---------
// If the operator's STATED goals (intent form, authored in
// synthetic_domain_goals) diverge from the DERIVED rollup of what their
// projects actually accomplish (rollup form, computed from goal_progress
// observations), that drift IS the synthetic-domain candidate. A new
// emergent domain crosses multiple projects in a way that the operator
// hasn't yet given a name to.
//
// Operationalization
// ------------------
// Pure-function implementation requires both sets of goals via metadata.
// The detector orchestrator populates:
//   metadata.intent_goals_by_project: project_id → intent_goal_text[]
//   metadata.rollup_goals_by_project: project_id → rollup_goal_text[]
//
// Algorithm:
//   1. For each candidate project, tokenize intent and rollup texts
//      separately, top-K most frequent each.
//   2. Per project, compute jaccard(intent, rollup). Higher overlap = LESS
//      drift; lower overlap = MORE drift.
//   3. Per-project drift = 1 - jaccard(intent, rollup).
//   4. raw_value = mean drift across candidate projects.
//
// Without metadata, returns 0 (no drift signal possible).

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

interface CandidateInputWithMetadata extends CandidateInput {
  metadata?: {
    intent_goals_by_project?: Record<string, string[]>;
    rollup_goals_by_project?: Record<string, string[]>;
  };
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has',
  'goal', 'goals', 'target', 'targets', 'will', 'would', 'should',
]);
const TOP_K = 20;

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function topKSet(s: string, k: number): Set<string> {
  const counts = new Map<string, number>();
  for (const t of tokenize(s)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return new Set(
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([t]) => t),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const v of a) if (b.has(v)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export const rollupAlignmentSignal: SignalExtractor = Object.freeze({
  name: 'rollup_alignment',
  family: 'goal',
  extract(input: CandidateInput): SignalEvalOutput {
    const meta = (input as CandidateInputWithMetadata).metadata;
    const intent = meta?.intent_goals_by_project;
    const rollup = meta?.rollup_goals_by_project;
    if (!intent || !rollup) {
      return {
        signal_name: 'rollup_alignment',
        raw_value: 0,
        normalized_value: 0,
        explanation:
          'no intent_goals_by_project + rollup_goals_by_project in metadata; signal contributes 0',
      };
    }

    let totalDrift = 0;
    let counted = 0;
    for (const pid of input.project_ids) {
      const intentText = (intent[pid] ?? []).join(' ');
      const rollupText = (rollup[pid] ?? []).join(' ');
      if (intentText.length === 0 && rollupText.length === 0) continue;
      const a = topKSet(intentText, TOP_K);
      const b = topKSet(rollupText, TOP_K);
      const drift = 1 - jaccard(a, b);
      totalDrift += drift;
      counted++;
    }

    if (counted === 0) {
      return {
        signal_name: 'rollup_alignment',
        raw_value: 0,
        normalized_value: 0,
        explanation: 'no candidate projects have intent + rollup goals',
      };
    }
    const meanDrift = totalDrift / counted;
    return {
      signal_name: 'rollup_alignment',
      raw_value: meanDrift,
      normalized_value: clamp01(meanDrift),
      explanation:
        `mean intent-vs-rollup drift across ${counted} candidate project(s) = ${meanDrift.toFixed(3)} ` +
        `(higher = more drift = stronger synthetic-domain signal)`,
    };
  },
});
