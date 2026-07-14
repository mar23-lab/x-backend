// src/workers/inference/signals/behavioral/artifact_cross_reference.ts
//
// R51-δ-B1 · Signal 3 of 14 (Behavioral) — `artifact_cross_reference`.
//
// §16.2 definition: "Count of artifacts (commits, docs, links) that
// explicitly cite multiple candidate domains."
//
// Operationalization
// ------------------
// An artifact reference is identified by:
//   1. `tags[]` array on the event (operator-applied labels)
//   2. URLs / project_id mentions in the event `summary`
//
// We count events whose `tags` (after intersecting with the candidate
// domain slugs in input.project_ids) hit ≥ 2 distinct candidate projects.
// Normalize against a saturation count of 30 (~ one cross-cutting artifact
// per day over the 30-day lookback).

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

const SATURATION_COUNT = 30;

export const artifactCrossReferenceSignal: SignalExtractor = Object.freeze({
  name: 'artifact_cross_reference',
  family: 'behavioral',
  extract(input: CandidateInput): SignalEvalOutput {
    const projectSet = new Set(input.project_ids);
    let crossRefCount = 0;
    for (const ev of input.events) {
      const tagHits = new Set<string>();
      if (Array.isArray(ev.tags)) {
        for (const tag of ev.tags) {
          if (projectSet.has(tag)) tagHits.add(tag);
        }
      }
      // Heuristic: a project_id substring in the summary is also a cross-ref
      // (e.g. links like https://app/projects/proj_X embed the id).
      if (typeof ev.summary === 'string') {
        for (const pid of projectSet) {
          if (pid !== ev.project_id && ev.summary.includes(pid)) {
            tagHits.add(pid);
          }
        }
      }
      // Event must reference ≥ 2 distinct candidate projects to count as
      // a cross-reference (its own project_id is one; one other tag/mention
      // is the second).
      if (tagHits.size + (ev.project_id ? 1 : 0) >= 2) {
        crossRefCount++;
      }
    }

    const normalized = clamp01(crossRefCount / SATURATION_COUNT);
    return {
      signal_name: 'artifact_cross_reference',
      raw_value: crossRefCount,
      normalized_value: normalized,
      explanation:
        `${crossRefCount} event(s) referenced ≥ 2 candidate projects via tags or summary; ` +
        `saturation at ${SATURATION_COUNT}; normalized = ${normalized.toFixed(3)}`,
    };
  },
});
