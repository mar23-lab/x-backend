// src/workers/inference/signals/structural/actor_jaccard.ts
//
// R51-δ-B1 · Signal 12 of 14 (Structural) — `actor_jaccard`.
//
// §16.2: "Jaccard overlap of the active-actor set across candidate domains
// over the lookback window."
//
// Operationalization
// ------------------
// Similar to membership_overlap but computed from EVENT actors (who
// actually DID something in the window), not from the membership snapshot.
// The active-actor set reflects current-behavior; the membership set
// reflects access-rights. Both signals carry weight because they catch
// different patterns:
//   - High membership + low actor_jaccard = shared access but separate work
//   - Low membership + high actor_jaccard = unusual: actor is touching
//     projects they're not formally a member of (e.g. operator probing)
//   - High both = canonical cross-cutting work
//
// Algorithm:
//   1. For each candidate project, build set of distinct actors observed
//      in events.
//   2. Pairwise Jaccard.
//   3. raw_value = mean Jaccard.

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const v of a) if (b.has(v)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export const actorJaccardSignal: SignalExtractor = Object.freeze({
  name: 'actor_jaccard',
  family: 'structural',
  extract(input: CandidateInput): SignalEvalOutput {
    const actorsByProject = new Map<string, Set<string>>();
    for (const ev of input.events) {
      if (!ev.project_id || !ev.actor) continue;
      let s = actorsByProject.get(ev.project_id);
      if (!s) {
        s = new Set();
        actorsByProject.set(ev.project_id, s);
      }
      s.add(ev.actor);
    }

    const sets: Set<string>[] = [];
    for (const pid of input.project_ids) {
      const s = actorsByProject.get(pid);
      if (s && s.size > 0) sets.push(s);
    }

    if (sets.length < 2) {
      return {
        signal_name: 'actor_jaccard',
        raw_value: 0,
        normalized_value: 0,
        explanation: `< 2 candidate projects have observed actors`,
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
      signal_name: 'actor_jaccard',
      raw_value: mean,
      normalized_value: clamp01(mean),
      explanation: `mean pairwise active-actor Jaccard (${sets.length} candidates, ${pairs} pairs) = ${mean.toFixed(3)}`,
    };
  },
});
