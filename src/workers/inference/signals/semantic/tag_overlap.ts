// src/workers/inference/signals/semantic/tag_overlap.ts
//
// R51-δ-B1 · Signal 8 of 14 (Semantic) — `tag_overlap`.
//
// §16.2: "Jaccard overlap of operator-applied tags + auto-extracted entities
// across candidate domains."
//
// Operationalization
// ------------------
// Each event MAY carry `tags[]` (operator-applied labels — operations,
// commercial, investor, ux, etc.). When projects in a candidate set share
// tags via their events, the candidate set has semantic coherence.
//
// Algorithm:
//   1. For each candidate project, collect the union of tags across its events.
//   2. Compute pairwise Jaccard overlap of those tag sets across candidates.
//   3. raw_value = mean pairwise Jaccard.
//   4. normalized = clamp01(raw_value).
//
// Auto-extracted entities (NER on event summaries) is deferred to R51 once
// `embedding_similarity` un-stubs and a shared NLP pipeline exists.

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const v of a) if (b.has(v)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export const tagOverlapSignal: SignalExtractor = Object.freeze({
  name: 'tag_overlap',
  family: 'semantic',
  extract(input: CandidateInput): SignalEvalOutput {
    // tag sets per project
    const tagsByProject = new Map<string, Set<string>>();
    for (const ev of input.events) {
      if (!ev.project_id || !Array.isArray(ev.tags)) continue;
      let s = tagsByProject.get(ev.project_id);
      if (!s) {
        s = new Set();
        tagsByProject.set(ev.project_id, s);
      }
      for (const t of ev.tags) {
        if (typeof t === 'string' && t.length > 0) s.add(t);
      }
    }

    // Candidate sets only
    const candidateSets: Set<string>[] = [];
    for (const pid of input.project_ids) {
      const s = tagsByProject.get(pid);
      if (s && s.size > 0) candidateSets.push(s);
    }

    if (candidateSets.length < 2) {
      return {
        signal_name: 'tag_overlap',
        raw_value: 0,
        normalized_value: 0,
        explanation: `< 2 candidate projects have tagged events; no overlap`,
      };
    }

    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < candidateSets.length; i++) {
      for (let j = i + 1; j < candidateSets.length; j++) {
        sum += jaccard(candidateSets[i]!, candidateSets[j]!);
        pairs++;
      }
    }
    const mean = pairs === 0 ? 0 : sum / pairs;

    return {
      signal_name: 'tag_overlap',
      raw_value: mean,
      normalized_value: clamp01(mean),
      explanation:
        `mean pairwise tag-set Jaccard (${candidateSets.length} candidates, ${pairs} pairs) = ${mean.toFixed(3)}`,
    };
  },
});
