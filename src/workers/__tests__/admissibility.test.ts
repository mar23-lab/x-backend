// admissibility.test.ts · M6 (260707) — proves the AI-context admissibility semantics: which states may
// enter the model's grounding context, and the behavior-preserving default for pre-migration/unknown rows.
// A change to CONTEXT_ADMISSIBLE (e.g. accidentally admitting 'excluded') fails here.

import { describe, it, expect } from 'vitest';
import { isAdmissibility, isAdmissibleForContext, ADMISSIBILITY_VALUES } from '../lib/admissibility';

describe('M6 admissibility enum', () => {
  it('has exactly the 4 states', () => {
    expect([...ADMISSIBILITY_VALUES].sort()).toEqual(['approved', 'candidate', 'excluded', 'visible']);
  });

  it('isAdmissibility guards the vocabulary', () => {
    expect(isAdmissibility('approved')).toBe(true);
    expect(isAdmissibility('banana')).toBe(false);
    expect(isAdmissibility(null)).toBe(false);
    expect(isAdmissibility(undefined)).toBe(false);
  });
});

describe('M6 isAdmissibleForContext', () => {
  it('admits approved + visible', () => {
    expect(isAdmissibleForContext('approved')).toBe(true);
    expect(isAdmissibleForContext('visible')).toBe(true);
  });

  it('holds OUT excluded + candidate', () => {
    expect(isAdmissibleForContext('excluded')).toBe(false);
    expect(isAdmissibleForContext('candidate')).toBe(false);
  });

  it('defaults unknown/null/undefined to admissible (behavior-preserving pre-migration)', () => {
    expect(isAdmissibleForContext(null)).toBe(true);
    expect(isAdmissibleForContext(undefined)).toBe(true);
    expect(isAdmissibleForContext('banana')).toBe(true);
  });
});
