// src/workers/inference/signals/goal/stated_goal_keyword_overlap.ts
//
// R51-δ-B1 · Signal 13 of 14 (Goal) — `stated_goal_keyword_overlap`.
//
// §16.2: "Keyword overlap between explicitly authored goals (intent form)
// across candidate domains."
//
// Operationalization
// ------------------
// Goals (synthetic_domain_goals table from migration 006) carry `title` +
// `description` + `metric_definition` JSONB. The detector orchestrator
// populates `metadata.goals_by_project` as `project_id → string[]` of
// concatenated goal text per project.
//
// Algorithm:
//   1. Tokenize each project's goal text (stop-word filtered, length ≥ 3).
//   2. Compute pairwise Jaccard overlap of those token sets across candidates.
//   3. raw_value = mean pairwise Jaccard.
//
// Without metadata.goals_by_project, signal returns 0.

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

interface CandidateInputWithMetadata extends CandidateInput {
  metadata?: { goals_by_project?: Record<string, string[]> };
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has',
  'goal', 'goals', 'target', 'targets', 'will', 'would', 'should',
  'metric', 'metrics', 'objective', 'objectives',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9_\-\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const v of a) if (b.has(v)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export const statedGoalKeywordOverlapSignal: SignalExtractor = Object.freeze({
  name: 'stated_goal_keyword_overlap',
  family: 'goal',
  extract(input: CandidateInput): SignalEvalOutput {
    const meta = (input as CandidateInputWithMetadata).metadata;
    const goals = meta?.goals_by_project;
    if (!goals) {
      return {
        signal_name: 'stated_goal_keyword_overlap',
        raw_value: 0,
        normalized_value: 0,
        explanation: 'no goals_by_project in CandidateInput.metadata; signal contributes 0',
      };
    }

    const sets: Set<string>[] = [];
    for (const pid of input.project_ids) {
      const texts = goals[pid];
      if (!Array.isArray(texts) || texts.length === 0) continue;
      sets.push(tokenize(texts.join(' ')));
    }
    if (sets.length < 2) {
      return {
        signal_name: 'stated_goal_keyword_overlap',
        raw_value: 0,
        normalized_value: 0,
        explanation: `< 2 candidate projects have goals`,
      };
    }

    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        sum += jaccard(sets[i]!, sets[j]!);
        pairs++;
      }
    }
    const mean = pairs === 0 ? 0 : sum / pairs;
    return {
      signal_name: 'stated_goal_keyword_overlap',
      raw_value: mean,
      normalized_value: clamp01(mean),
      explanation: `mean pairwise goal-token Jaccard (${sets.length} candidates, ${pairs} pairs) = ${mean.toFixed(3)}`,
    };
  },
});
