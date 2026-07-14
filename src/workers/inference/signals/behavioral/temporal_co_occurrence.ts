// src/workers/inference/signals/behavioral/temporal_co_occurrence.ts
//
// R51-δ-A2 · Signal 2 of 14 (Behavioral family) — `temporal_co_occurrence`.
//
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16.2 Behavioral row 2:
//   "Density of events from multiple candidate domains within tight time
//   windows (e.g. same session, same hour)"
//
// Intuition
// ---------
// When events from project A and project B fire within the same operator-hour,
// that's a stronger cross-cutting signal than the same two events being weeks
// apart. We bucket events by hour and count buckets containing events from
// ≥ 2 candidate projects.
//
// Algorithm
// ---------
// 1. For each event, compute its hour-bucket key = `floor(occurred_at / 3600s)`.
// 2. Group event project_ids by hour-bucket.
// 3. raw_value = count of buckets containing events from ≥ 2 distinct candidate projects.
// 4. Normalize: linear over expected hour-bucket density in the lookback window.
//    Default lookback = 30 days = 720 hours. A normalized score of 1.0
//    corresponds to ≥ 30% of operating hours being cross-cutting (i.e. ~216 buckets).
//
// Operating-hour assumption: ~24 hours/day × 30 days = 720 buckets potential.
// 30% saturation ≈ 216 buckets. Tunable via SATURATION_BUCKET_COUNT below.

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

const SATURATION_BUCKET_COUNT = 216;
const HOUR_MS = 60 * 60 * 1000;

export const temporalCoOccurrenceSignal: SignalExtractor = Object.freeze({
  name: 'temporal_co_occurrence',
  family: 'behavioral',
  extract(input: CandidateInput): SignalEvalOutput {
    // hour-bucket → Set<project_id>
    const byBucket = new Map<number, Set<string>>();
    for (const ev of input.events) {
      if (!ev.occurred_at || !ev.project_id) continue;
      const ts = Date.parse(ev.occurred_at);
      if (!Number.isFinite(ts)) continue;
      const bucket = Math.floor(ts / HOUR_MS);
      let set = byBucket.get(bucket);
      if (!set) {
        set = new Set();
        byBucket.set(bucket, set);
      }
      set.add(ev.project_id);
    }

    let crossCuttingBuckets = 0;
    for (const projectSet of byBucket.values()) {
      if (projectSet.size >= 2) crossCuttingBuckets++;
    }

    const normalized = clamp01(crossCuttingBuckets / SATURATION_BUCKET_COUNT);

    return {
      signal_name: 'temporal_co_occurrence',
      raw_value: crossCuttingBuckets,
      normalized_value: normalized,
      explanation:
        `${crossCuttingBuckets} hour-bucket(s) contained events from ≥ 2 candidate ` +
        `projects (saturation at ${SATURATION_BUCKET_COUNT}; normalized = ${normalized.toFixed(3)})`,
    };
  },
});
