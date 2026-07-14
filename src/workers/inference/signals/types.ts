// src/workers/inference/signals/types.ts
//
// R51-δ-A2 · Signal extractor contract.
//
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16.2 (14-signal
// taxonomy across 4 families).
//
// Every signal extractor in `src/workers/inference/signals/{family}/*.ts`
// conforms to the SignalExtractor interface. The detector cron (Wave δ-B)
// iterates over all configured signals, invokes them in parallel, and
// writes one inference_signal_evals row per (candidate × signal).
//
// Why a strict interface
// ----------------------
// - Deterministic ordering (signal_names array on detector_config governs)
// - Same input shape per signal → easier to unit-test in isolation
// - Self-maintenance loop 1 (weight retune) can swap weights without
//   touching extractor code
// - Loop 6 (shadow-eval for new signals) introduces a signal by adding
//   one module + bumping detector_config — no engine changes needed

import type { EventId, ProjectId } from '../../dal/types';

/**
 * A single candidate domain set being evaluated. Same shape feeds every
 * signal extractor in a run. The detector cron builds CandidateInput
 * once per run and reuses across all signals (zero N-pass inefficiency).
 */
export interface CandidateInput {
  /** Stable hash of the candidate domain set (e.g. cf_hobby_career_health). */
  readonly candidate_fingerprint: string;
  /** Project IDs in the candidate set (the binding member set). */
  readonly project_ids: readonly ProjectId[];
  /** Events inside the lookback window touching ≥ 1 candidate project. */
  readonly events: readonly CandidateEvent[];
  /** Operator + agent IDs that appear in the events (cached for speed). */
  readonly actors: readonly string[];
  /** Lookback window. */
  readonly window_start: string; // ISO8601
  readonly window_end: string;   // ISO8601
}

/**
 * Event shape consumed by signal extractors. Mirrors the
 * synthetic_domain_propagation engine's event view from migration 007 but
 * trimmed to fields signal extractors actually use.
 */
export interface CandidateEvent {
  readonly id: EventId;
  readonly project_id: ProjectId;
  readonly source_tool: string;
  readonly actor: string;
  readonly occurred_at: string; // ISO8601
  readonly summary: string;
  readonly tags?: readonly string[];
}

/**
 * Output of a single signal extraction. Maps onto an inference_signal_evals row.
 */
export interface SignalEvalOutput {
  /** The signal that produced this output (must match SignalExtractor.name). */
  readonly signal_name: string;
  /** Pre-normalization observation (e.g. count, jaccard, days). */
  readonly raw_value: number;
  /** [0,1] normalized value. */
  readonly normalized_value: number;
  /** Optional human-readable rationale for debug/UI hover. */
  readonly explanation?: string;
}

/**
 * Contract for every signal in §16.2. Stateless and synchronous in pure
 * Worker code; signals that need async lookups (e.g. embeddings) extend
 * to SignalExtractorAsync (R51 once embedding_similarity un-stubs).
 */
export interface SignalExtractor {
  /** Stable name (matches detector_config.signal_names and migration 010 keys). */
  readonly name: string;
  /** One of the 4 families per §16.2 (used for grouping in UI breakdown). */
  readonly family: 'behavioral' | 'semantic' | 'structural' | 'goal';
  /** Pure function: same inputs → same outputs. No side effects, no IO. */
  extract(input: CandidateInput): SignalEvalOutput;
}

/**
 * Helper: clamp into [0,1] for normalization functions that derive from
 * unbounded counts. Each extractor decides its own normalization curve
 * (linear, log-scaled, sigmoid, jaccard) but the final value MUST be in
 * [0,1] per the §16.2 contract.
 */
export function clamp01(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
