// src/workers/inference/signals/structural/membership_overlap.ts
//
// R51-δ-B1 · Signal 11 of 14 (Structural) — `membership_overlap`.
//
// §16.2: "Jaccard overlap of project memberships (people/agents who
// participate in both) [across candidate domains]."
//
// Operationalization
// ------------------
// Project memberships live in the workspace_memberships table (operator,
// human collaborators, agents). They are NOT carried on individual events
// — they're a snapshot of "who has access to project X". The detector
// orchestrator populates `metadata.memberships` as a map
// `project_id → string[] of member_ids`.
//
// Algorithm:
//   1. For each candidate project, look up its membership set.
//   2. Pairwise Jaccard overlap of those member-id sets.
//   3. raw_value = mean pairwise Jaccard.
//
// Without metadata.memberships, signal returns 0.

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

interface CandidateInputWithMetadata extends CandidateInput {
  metadata?: { memberships?: Record<string, string[]> };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const v of a) if (b.has(v)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export const membershipOverlapSignal: SignalExtractor = Object.freeze({
  name: 'membership_overlap',
  family: 'structural',
  extract(input: CandidateInput): SignalEvalOutput {
    const meta = (input as CandidateInputWithMetadata).metadata;
    const memberships = meta?.memberships;
    if (!memberships) {
      return {
        signal_name: 'membership_overlap',
        raw_value: 0,
        normalized_value: 0,
        explanation: 'no memberships in CandidateInput.metadata; signal contributes 0',
      };
    }

    const sets: Set<string>[] = [];
    for (const pid of input.project_ids) {
      const members = memberships[pid];
      if (Array.isArray(members) && members.length > 0) {
        sets.push(new Set(members));
      }
    }
    if (sets.length < 2) {
      return {
        signal_name: 'membership_overlap',
        raw_value: 0,
        normalized_value: 0,
        explanation: `< 2 candidate projects have memberships`,
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
      signal_name: 'membership_overlap',
      raw_value: mean,
      normalized_value: clamp01(mean),
      explanation: `mean pairwise membership Jaccard (${sets.length} candidates, ${pairs} pairs) = ${mean.toFixed(3)}`,
    };
  },
});
