// src/workers/inference/signals/semantic/embedding_similarity.ts
//
// R51-δ-B1 · Signal 9 of 14 (Semantic) — `embedding_similarity`.
//
// §16.2: "Cosine similarity of event-body embeddings across candidate domains.
// **STUBBED weight = 0 in R50**; activates R51 with MLX or Workers AI;
// enters via shadow-eval (§16.5 loop 6)"
//
// Status
// ------
// R50 stub: returns normalized_value = 0 for ALL inputs. Weight in
// detector_config.weights = 0.00 (set by migration 010). This signal
// participates in the inference pipeline (registry, run audit) but
// contributes zero to composite confidence until shadow-eval (§16.5 loop 6)
// graduates it.
//
// Activation path (Wave δ-C or later):
//   1. Wire MLX (`mlx-llm-server` running on operator's Mac) OR
//      Workers AI (Cloudflare's @cf/baai/bge-* models).
//   2. Replace the stub with real cosine-similarity computation across
//      candidate-event embedding centroids.
//   3. Enter shadow-eval window (30 days) with weight still 0.
//   4. After shadow-eval validates the signal correlates with operator
//      decisions, weight retune (loop 1) lifts weight from 0 to the
//      learned value.
//
// Why ship the stub now (and not defer entirely)
// ----------------------------------------------
// - Reserves the position in detector_config.signal_names (no future
//   migration to add the row)
// - Audit-traceability: inference_signal_evals row still written (raw=0,
//   normalized=0) so the operator sees "embedding signal: not yet active"
//   in the breakdown drawer
// - Forces the SignalExtractor contract to be the integration boundary
//   for non-pure-function signals BEFORE they exist

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';

export const embeddingSimilaritySignal: SignalExtractor = Object.freeze({
  name: 'embedding_similarity',
  family: 'semantic',
  extract(_input: CandidateInput): SignalEvalOutput {
    return {
      signal_name: 'embedding_similarity',
      raw_value: 0,
      normalized_value: 0,
      explanation:
        'STUBBED in R50 (weight=0.00 in detector_config). Activates in R51 ' +
        'via MLX or Workers AI; enters via §16.5 loop 6 shadow-eval.',
    };
  },
});
