// src/workers/inference/signals/behavioral/sequence_pattern.ts
//
// R51-δ-B1 · Signal 4 of 14 (Behavioral) — `sequence_pattern`.
//
// §16.2 definition: "Match score against learned sequence templates (e.g.
// 'investigate → propose → implement → test' pattern across 4 domains)."
//
// Operationalization (R50 lightweight version)
// -------------------------------------------
// True sequence-template learning requires a corpus of operator-tagged
// pattern sequences which we don't have yet. For R50, we approximate with
// a heuristic: count distinct N-day intervals where events from the
// candidate domain set ARRIVED in a non-trivial ordering (≥ 3 distinct
// domains touched in the same week, in sequence).
//
// Algorithm:
//   1. Group events into ISO-week buckets (week = floor(ts / 7 days)).
//   2. Per week, count distinct candidate domains touched.
//   3. raw_value = number of weeks with ≥ 3 distinct candidate domains touched.
//   4. Normalize against the count of weeks in the lookback window
//      (default ~4-5 weeks at 30 day window).
//
// Wave ζ self-maintenance loop 6 (new-signal shadow-eval) will swap this
// heuristic for learned templates when the operator accumulates ≥ 30 days
// of labeled sequence data.

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SEQUENCE_DOMAINS_REQUIRED = 3;
const SATURATION_WEEK_FRACTION = 0.5; // saturation at 50% of weeks showing sequence

export const sequencePatternSignal: SignalExtractor = Object.freeze({
  name: 'sequence_pattern',
  family: 'behavioral',
  extract(input: CandidateInput): SignalEvalOutput {
    const startTs = Date.parse(input.window_start);
    const endTs = Date.parse(input.window_end);
    let totalWeeks = 0;
    if (Number.isFinite(startTs) && Number.isFinite(endTs) && endTs > startTs) {
      totalWeeks = Math.max(1, Math.ceil((endTs - startTs) / WEEK_MS));
    }

    const byWeek = new Map<number, Set<string>>();
    for (const ev of input.events) {
      const ts = Date.parse(ev.occurred_at);
      if (!Number.isFinite(ts) || !ev.project_id) continue;
      const week = Math.floor(ts / WEEK_MS);
      let set = byWeek.get(week);
      if (!set) {
        set = new Set();
        byWeek.set(week, set);
      }
      set.add(ev.project_id);
    }

    let sequenceWeeks = 0;
    for (const projectSet of byWeek.values()) {
      if (projectSet.size >= SEQUENCE_DOMAINS_REQUIRED) sequenceWeeks++;
    }

    // Normalize: sequenceWeeks / (totalWeeks * SATURATION_WEEK_FRACTION)
    // Means: hitting ≥ 50% of weeks with sequence saturates the signal.
    const saturation = Math.max(1, totalWeeks * SATURATION_WEEK_FRACTION);
    const normalized = clamp01(sequenceWeeks / saturation);

    return {
      signal_name: 'sequence_pattern',
      raw_value: sequenceWeeks,
      normalized_value: normalized,
      explanation:
        `${sequenceWeeks} week(s) had ≥ ${SEQUENCE_DOMAINS_REQUIRED} candidate domains touched ` +
        `(window=${totalWeeks}w, saturation at ${saturation.toFixed(1)}w; normalized = ${normalized.toFixed(3)})`,
    };
  },
});
