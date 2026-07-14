// src/workers/inference/signals/semantic/keyword_co_occurrence.ts
//
// R51-δ-B1 · Signal 6 of 14 (Semantic) — `keyword_co_occurrence`.
//
// §16.2: "TF-IDF-weighted overlap of distinctive keywords across candidate-
// domain event bodies."
//
// Operationalization (R50 — no corpus statistics yet)
// ---------------------------------------------------
// True TF-IDF requires a corpus baseline (term frequencies across all of
// the operator's events, not just the candidate set). Wave δ-B ships a
// stop-word-filtered Jaccard overlap of the top-K distinctive tokens per
// candidate project's events, which approximates TF-IDF overlap when the
// vocabulary is operator-scale (~10³ events).
//
// Algorithm:
//   1. For each candidate project, tokenize event summaries → tokens.
//   2. Apply STOP_WORDS filter + length-2-minimum + lowercase.
//   3. Keep top-K (default 30) tokens per project by frequency.
//   4. raw_value = mean pairwise Jaccard overlap across candidate projects.
//   5. normalized = clamp01(raw_value).
//
// Wave ζ loop 6 (shadow-eval) will upgrade to true TF-IDF once a corpus
// baseline accumulates.

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

const TOP_K = 30;
const MIN_TOKEN_LENGTH = 3;
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has',
  'was', 'were', 'are', 'will', 'would', 'should', 'could', 'one',
  'two', 'three', 'all', 'any', 'some', 'each', 'they', 'them', 'their',
  'there', 'these', 'those', 'into', 'about', 'after', 'before',
  'between', 'through', 'such', 'than', 'only', 'just', 'also',
  'when', 'where', 'how', 'why', 'who', 'what', 'which',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(t));
}

function topKTokens(tokens: string[], k: number): Set<string> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return new Set(sorted.slice(0, k).map(([t]) => t));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const v of a) if (b.has(v)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export const keywordCoOccurrenceSignal: SignalExtractor = Object.freeze({
  name: 'keyword_co_occurrence',
  family: 'semantic',
  extract(input: CandidateInput): SignalEvalOutput {
    // Group tokens by project
    const tokensByProject = new Map<string, string[]>();
    for (const ev of input.events) {
      if (!ev.project_id || !ev.summary) continue;
      let arr = tokensByProject.get(ev.project_id);
      if (!arr) {
        arr = [];
        tokensByProject.set(ev.project_id, arr);
      }
      for (const t of tokenize(ev.summary)) arr.push(t);
    }

    // Build top-K sets per candidate project (only projects in the candidate set)
    const candidateSets: Set<string>[] = [];
    for (const pid of input.project_ids) {
      const arr = tokensByProject.get(pid) ?? [];
      if (arr.length === 0) continue;
      candidateSets.push(topKTokens(arr, TOP_K));
    }

    if (candidateSets.length < 2) {
      return {
        signal_name: 'keyword_co_occurrence',
        raw_value: 0,
        normalized_value: 0,
        explanation: `< 2 candidate projects have events; no overlap possible`,
      };
    }

    // Pairwise Jaccard mean
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < candidateSets.length; i++) {
      for (let j = i + 1; j < candidateSets.length; j++) {
        sum += jaccard(candidateSets[i]!, candidateSets[j]!);
        pairs++;
      }
    }
    const meanJaccard = pairs === 0 ? 0 : sum / pairs;
    const normalized = clamp01(meanJaccard);

    return {
      signal_name: 'keyword_co_occurrence',
      raw_value: meanJaccard,
      normalized_value: normalized,
      explanation:
        `mean pairwise Jaccard over top-${TOP_K} tokens (${candidateSets.length} candidates, ` +
        `${pairs} pairs) = ${meanJaccard.toFixed(3)}; normalized=${normalized.toFixed(3)}`,
    };
  },
});
