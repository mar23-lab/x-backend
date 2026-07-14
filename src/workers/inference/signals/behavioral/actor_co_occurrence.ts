// src/workers/inference/signals/behavioral/actor_co_occurrence.ts
//
// R51-δ-A2 · Signal 1 of 14 (Behavioral family) — `actor_co_occurrence`.
//
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16.2 Behavioral row 1:
//   "Frequency at which the same `actor` (operator, agent, or external user)
//   appears across multiple candidate domains in a co-occurrence bucket"
//
// Intuition
// ---------
// If the same actor (operator, agent, external collaborator) shows up in
// project A AND project B AND project C within the lookback window, that's
// a strong cross-cutting signal — those projects ARE the same person's
// concern, statistically.
//
// Algorithm
// ---------
// 1. Group events by actor.
// 2. For each actor, count how many DISTINCT candidate projects they touched.
// 3. raw_value = sum over all actors of (projects_touched - 1) where
//    projects_touched ≥ 2. (A single-project actor contributes 0; a 4-project
//    actor contributes 3.)
// 4. Normalize: sigmoid-ish — value / (value + 5). Tunable midpoint = 5
//    means "5 cross-cutting touches" yields normalized = 0.5. Saturates
//    asymptotically toward 1 as touches grow.
//
// Why sigmoid (vs linear)
// -----------------------
// One blockbuster actor touching all 4 projects is strong; 30 actors each
// touching 2 projects is weaker per-actor but the aggregate is interpretable.
// Sigmoid prevents whales from dominating while still rewarding cross-cutting.

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

const SIGMOID_MIDPOINT = 5;

export const actorCoOccurrenceSignal: SignalExtractor = Object.freeze({
  name: 'actor_co_occurrence',
  family: 'behavioral',
  extract(input: CandidateInput): SignalEvalOutput {
    // actor → Set<project_id>
    const byActor = new Map<string, Set<string>>();
    for (const ev of input.events) {
      if (!ev.actor || !ev.project_id) continue;
      let set = byActor.get(ev.actor);
      if (!set) {
        set = new Set();
        byActor.set(ev.actor, set);
      }
      set.add(ev.project_id);
    }

    let raw = 0;
    let crossCuttingActors = 0;
    for (const projectSet of byActor.values()) {
      if (projectSet.size >= 2) {
        raw += projectSet.size - 1;
        crossCuttingActors++;
      }
    }

    const normalized = clamp01(raw / (raw + SIGMOID_MIDPOINT));

    return {
      signal_name: 'actor_co_occurrence',
      raw_value: raw,
      normalized_value: normalized,
      explanation:
        `${crossCuttingActors} actor(s) touched multiple candidate projects ` +
        `(total cross-cutting touches = ${raw}; normalized = ${normalized.toFixed(3)})`,
    };
  },
});
