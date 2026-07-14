// src/workers/inference/signals/semantic/intent_keyword_density.ts
//
// R51-δ-B1 · Signal 7 of 14 (Semantic) — `intent_keyword_density`.
//
// §16.2: "Density of intent-marker keywords (e.g. 'goal', 'plan', 'ship',
// 'verify') in the candidate domain set."
//
// Operationalization
// ------------------
// Intent markers signal that operator is THINKING in domain terms (planning,
// goal-setting, verification cycle) rather than reacting. A candidate domain
// set with high intent density is more "domain-like" than a transactional
// one.
//
// Algorithm:
//   1. Count occurrences of INTENT_KEYWORDS in candidate-event summaries.
//   2. Density = intent_count / total_words.
//   3. Normalize against a saturation density of 0.05 (~5% of words being
//      intent markers is strong signal).

import type { SignalExtractor, CandidateInput, SignalEvalOutput } from '../types';
import { clamp01 } from '../types';

const INTENT_KEYWORDS = new Set([
  // planning/goal verbs
  'goal', 'plan', 'planning', 'ship', 'verify', 'verified', 'verifying',
  'intent', 'objective', 'milestone', 'roadmap', 'target', 'targets',
  'commit', 'commits', 'committed', 'deliver', 'delivered',
  'deadline', 'release', 'launch', 'launched', 'released',
  // verification/closure verbs
  'closeout', 'closing', 'closed', 'closure', 'accepted', 'approved',
  'sign-off', 'signoff', 'reviewed', 'review', 'audit', 'audited',
  // intent-state nouns
  'priority', 'priorities', 'focus', 'scope', 'definition', 'requirement',
  'spec', 'specification', 'criterion', 'criteria',
]);

const SATURATION_DENSITY = 0.05;

export const intentKeywordDensitySignal: SignalExtractor = Object.freeze({
  name: 'intent_keyword_density',
  family: 'semantic',
  extract(input: CandidateInput): SignalEvalOutput {
    const projectSet = new Set(input.project_ids);
    let intentHits = 0;
    let totalWords = 0;

    for (const ev of input.events) {
      if (!projectSet.has(ev.project_id)) continue;
      if (typeof ev.summary !== 'string') continue;
      const words = ev.summary.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
      totalWords += words.length;
      for (const w of words) {
        const clean = w.replace(/[^a-z0-9_\-]/g, '');
        if (INTENT_KEYWORDS.has(clean)) intentHits++;
      }
    }

    const density = totalWords === 0 ? 0 : intentHits / totalWords;
    const normalized = clamp01(density / SATURATION_DENSITY);

    return {
      signal_name: 'intent_keyword_density',
      raw_value: density,
      normalized_value: normalized,
      explanation:
        `${intentHits} intent-marker word(s) / ${totalWords} total ` +
        `(density=${density.toFixed(4)}; saturation at ${SATURATION_DENSITY}; normalized=${normalized.toFixed(3)})`,
    };
  },
});
