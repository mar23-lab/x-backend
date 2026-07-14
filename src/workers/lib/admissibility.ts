// admissibility.ts · M6 (260707) · AI-context admissibility — the single source of truth for the enum.
//
// P11 (unique-to-category control): "what may enter the model's context" is an EXPLICIT, per-item,
// governed state, not an implicit side effect of having extracted text. This module is the ONE place the
// 4-state vocabulary lives — the migration CHECK (049), the DAL, the route validation, and the grounding
// filter all bind to it, so the enum can never drift out of lockstep (frozen by verify:admissibility-enum-ssot).
//
// Semantics (matches the new UI's Admissibility axis):
//   approved  — cleared to enter model context (the behavior-preserving default; existing docs backfill here)
//   visible   — surfaced to the operator AND admissible to context (a lighter "ok to use" than a formal approval)
//   candidate — proposed, NOT yet cleared → held OUT of context pending review
//   excluded  — explicitly barred from context

export type Admissibility = 'visible' | 'excluded' | 'candidate' | 'approved';

/** The frozen enum, in the migration's CHECK order. The gate asserts this matches 049 + the route. */
export const ADMISSIBILITY_VALUES = ['visible', 'excluded', 'candidate', 'approved'] as const;

/** The states that MAY enter the model's context. Excluded/candidate are held out. */
const CONTEXT_ADMISSIBLE = new Set<Admissibility>(['approved', 'visible']);

export function isAdmissibility(v: unknown): v is Admissibility {
  return typeof v === 'string' && (ADMISSIBILITY_VALUES as readonly string[]).includes(v);
}

/** May this item enter the model's grounding context? Unknown/absent → treat as 'approved' (behavior-preserving). */
export function isAdmissibleForContext(v: unknown): boolean {
  if (!isAdmissibility(v)) return true; // pre-migration rows / null default to admissible (no silent regression)
  return CONTEXT_ADMISSIBLE.has(v);
}
