// src/workers/inference/signals/index.ts
//
// R51-δ-B1 · Complete 14-signal registry barrel.
//
// Wave δ-A shipped 2 (actor_co_occurrence, temporal_co_occurrence).
// Wave δ-B1 (this commit) appends the remaining 12 to complete the
// §16.2 taxonomy.
//
// Order in SIGNAL_REGISTRY matches detector_config.signal_names from
// migration 010 so deterministic iteration is preserved. Detector cron
// (Wave δ-B3) reads this in order; new signals (Wave ζ loop 6 shadow-eval)
// append at the end.

import type { SignalExtractor } from './types';

// Behavioral family (5)
import { actorCoOccurrenceSignal } from './behavioral/actor_co_occurrence';
import { temporalCoOccurrenceSignal } from './behavioral/temporal_co_occurrence';
import { artifactCrossReferenceSignal } from './behavioral/artifact_cross_reference';
import { sequencePatternSignal } from './behavioral/sequence_pattern';
import { dwellConcentrationSignal } from './behavioral/dwell_concentration';

// Semantic family (4)
import { keywordCoOccurrenceSignal } from './semantic/keyword_co_occurrence';
import { intentKeywordDensitySignal } from './semantic/intent_keyword_density';
import { tagOverlapSignal } from './semantic/tag_overlap';
import { embeddingSimilaritySignal } from './semantic/embedding_similarity';

// Structural family (3)
import { parentDistanceSignal } from './structural/parent_distance';
import { membershipOverlapSignal } from './structural/membership_overlap';
import { actorJaccardSignal } from './structural/actor_jaccard';

// Goal family (2)
import { statedGoalKeywordOverlapSignal } from './goal/stated_goal_keyword_overlap';
import { rollupAlignmentSignal } from './goal/rollup_alignment';

// ── Public re-exports ─────────────────────────────────────────────────
export type {
  SignalExtractor,
  SignalEvalOutput,
  CandidateInput,
  CandidateEvent,
} from './types';
export { clamp01 } from './types';

// Behavioral
export { actorCoOccurrenceSignal } from './behavioral/actor_co_occurrence';
export { temporalCoOccurrenceSignal } from './behavioral/temporal_co_occurrence';
export { artifactCrossReferenceSignal } from './behavioral/artifact_cross_reference';
export { sequencePatternSignal } from './behavioral/sequence_pattern';
export { dwellConcentrationSignal } from './behavioral/dwell_concentration';

// Semantic
export { keywordCoOccurrenceSignal } from './semantic/keyword_co_occurrence';
export { intentKeywordDensitySignal } from './semantic/intent_keyword_density';
export { tagOverlapSignal } from './semantic/tag_overlap';
export { embeddingSimilaritySignal } from './semantic/embedding_similarity';

// Structural
export { parentDistanceSignal } from './structural/parent_distance';
export { membershipOverlapSignal } from './structural/membership_overlap';
export { actorJaccardSignal } from './structural/actor_jaccard';

// Goal
export { statedGoalKeywordOverlapSignal } from './goal/stated_goal_keyword_overlap';
export { rollupAlignmentSignal } from './goal/rollup_alignment';

/**
 * Complete 14-signal registry per §16.2. Order matches
 * detector_config.signal_names from migration 010 for deterministic
 * iteration in the detector cron.
 */
export const SIGNAL_REGISTRY: ReadonlyArray<SignalExtractor> = Object.freeze([
  // Behavioral (5)
  actorCoOccurrenceSignal,
  temporalCoOccurrenceSignal,
  artifactCrossReferenceSignal,
  sequencePatternSignal,
  dwellConcentrationSignal,
  // Semantic (4)
  keywordCoOccurrenceSignal,
  intentKeywordDensitySignal,
  tagOverlapSignal,
  embeddingSimilaritySignal,
  // Structural (3)
  parentDistanceSignal,
  membershipOverlapSignal,
  actorJaccardSignal,
  // Goal (2)
  statedGoalKeywordOverlapSignal,
  rollupAlignmentSignal,
]);

/** O(1) lookup. Frozen at module load. */
export const SIGNAL_BY_NAME: Readonly<Record<string, SignalExtractor>> = Object.freeze(
  SIGNAL_REGISTRY.reduce<Record<string, SignalExtractor>>((acc, sig) => {
    acc[sig.name] = sig;
    return acc;
  }, {}),
);

/** Grouped-by-family view (for UI breakdown drawer rendering). */
export const SIGNAL_BY_FAMILY: Readonly<Record<SignalExtractor['family'], readonly SignalExtractor[]>> = Object.freeze({
  behavioral: Object.freeze(SIGNAL_REGISTRY.filter((s) => s.family === 'behavioral')),
  semantic: Object.freeze(SIGNAL_REGISTRY.filter((s) => s.family === 'semantic')),
  structural: Object.freeze(SIGNAL_REGISTRY.filter((s) => s.family === 'structural')),
  goal: Object.freeze(SIGNAL_REGISTRY.filter((s) => s.family === 'goal')),
});
