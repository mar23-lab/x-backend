// src/workers/inference/signals/behavioral/dwell_concentration.ts
//
// R51-δ-B1 · Signal 5 of 14 (Behavioral) — `dwell_concentration`.
//
// §16.2 definition: "Concentration of operator dwell time (UI focus, events
// per session) inside the candidate domain set vs. background."
//
// Operationalization
// ------------------
// We don't have explicit UI-focus telemetry in R50. Proxy: event-count
// concentration. If the candidate domain set's events are X% of all events
// touching any candidate project (the candidate set's "membership"), and
// X > background expected (1/N where N = number of operator-owned projects),
// that's concentration.
//
// Algorithm (simplified for R50):
//   raw_value = |events in candidate set| / max(1, |all events|)
//   normalized = clamp01(raw_value * 2)
//
// Multiplier of 2 because a candidate set drawing 50% of all events is
// strongly concentrated (50% on N candidate projects vs the rest of the
// operator's universe), so we saturate at the 50% mark.
//
// NOTE: this signal naturally returns 1.0 when input.events is filtered
// to ONLY candidate-touching events (which the detector orchestrator does
// in Wave δ-B3). In that case the signal becomes a baseline indicator
// rather than a discriminator. The orchestrator MAY pass a broader event
// window (incl. non-candidate events) to make this signal meaningful.

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

const SATURATION_MULTIPLIER = 2;

export const dwellConcentrationSignal: SignalExtractor = Object.freeze({
  name: 'dwell_concentration',
  family: 'behavioral',
  extract(input: CandidateInput): SignalEvalOutput {
    const projectSet = new Set(input.project_ids);
    let candidateEvents = 0;
    for (const ev of input.events) {
      if (projectSet.has(ev.project_id)) candidateEvents++;
    }
    const total = input.events.length;
    const ratio = total === 0 ? 0 : candidateEvents / total;
    const normalized = clamp01(ratio * SATURATION_MULTIPLIER);

    return {
      signal_name: 'dwell_concentration',
      raw_value: ratio,
      normalized_value: normalized,
      explanation:
        `${candidateEvents}/${total} events touched the candidate set ` +
        `(ratio=${ratio.toFixed(3)}; saturation at 0.5; normalized=${normalized.toFixed(3)})`,
    };
  },
});
