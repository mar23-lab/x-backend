// src/workers/inference/signals/structural/parent_distance.ts
//
// R51-δ-B1 · Signal 10 of 14 (Structural) — `parent_distance`.
//
// §16.2: "Distance in the project tree (`parent_project_id` chain) between
// candidate domains; closer = stronger structural link."
//
// Operationalization
// ------------------
// Each Project carries an optional parent_project_id (migration 004 added
// the column). A "distance" between two projects is the number of edges
// in the parent chain to reach a common ancestor (closer = stronger signal).
//
// Algorithm (the parent map is not in CandidateInput — must be passed via
// `metadata.parent_map` if available, else signal returns 0):
//   1. Read parent_map from input metadata if present.
//   2. For each pair of candidate projects, compute min distance via BFS.
//   3. raw_value = mean inverse distance (1/(d+1)) — siblings have d=2 → 0.33,
//      parent-child d=1 → 0.50, same node d=0 → 1.0.
//   4. normalized = clamp01(raw_value).
//
// Detector orchestrator (Wave δ-B3) populates input.metadata.parent_map.
// Without it, the signal contributes 0.

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

interface CandidateInputWithMetadata extends CandidateInput {
  metadata?: { parent_map?: Record<string, string | null> };
}

function distance(
  a: string,
  b: string,
  parentMap: Record<string, string | null>,
): number {
  if (a === b) return 0;
  // BFS from a, tracking depth
  const visited = new Map<string, number>();
  visited.set(a, 0);
  const queue: string[] = [a];
  // Walk a's ancestors first (cap chain at 16 to avoid pathological cycles)
  let cur: string | null = a;
  for (let i = 0; i < 16 && cur; i++) {
    const next: string | null = parentMap[cur] ?? null;
    if (!next) break;
    visited.set(next, i + 1);
    queue.push(next);
    cur = next;
  }
  // Now walk b's ancestors; if we hit any in `visited`, total distance =
  // b-depth + a-stored depth.
  cur = b;
  for (let i = 0; i < 16 && cur; i++) {
    if (visited.has(cur)) {
      return i + (visited.get(cur) ?? 0);
    }
    cur = parentMap[cur] ?? null;
  }
  // No common ancestor found within depth cap
  return 16;
}

export const parentDistanceSignal: SignalExtractor = Object.freeze({
  name: 'parent_distance',
  family: 'structural',
  extract(input: CandidateInput): SignalEvalOutput {
    const meta = (input as CandidateInputWithMetadata).metadata;
    const parentMap = meta?.parent_map;
    if (!parentMap || typeof parentMap !== 'object') {
      return {
        signal_name: 'parent_distance',
        raw_value: 0,
        normalized_value: 0,
        explanation: 'no parent_map in CandidateInput.metadata; signal contributes 0',
      };
    }
    const projects = input.project_ids;
    if (projects.length < 2) {
      return {
        signal_name: 'parent_distance',
        raw_value: 0,
        normalized_value: 0,
        explanation: `< 2 candidate projects; no pairwise distance`,
      };
    }

    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const d = distance(projects[i]!, projects[j]!, parentMap);
        sum += 1 / (d + 1);
        pairs++;
      }
    }
    const mean = pairs === 0 ? 0 : sum / pairs;
    return {
      signal_name: 'parent_distance',
      raw_value: mean,
      normalized_value: clamp01(mean),
      explanation: `mean inverse parent-distance across ${pairs} pair(s) = ${mean.toFixed(3)}`,
    };
  },
});
