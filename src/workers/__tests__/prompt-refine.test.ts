// prompt-refine.test.ts · 2026-06-10 · W4
// Unit tests for refinePromptText — the never-throws "Improve wording" primitive. The whole point is
// that the operator can NEVER lose their text: a missing binding, a throw, a no-op rewrite, or a
// degenerate output ALL return the original with refined=false.

import { describe, it, expect } from 'vitest';
import { refinePromptText } from '../services/prompt-refine';

const aiReturning = (response: unknown) => ({ run: async () => ({ response }) });
const aiThrowing = { run: async () => { throw new Error('model down'); } };

describe('refinePromptText', () => {
  it('returns the original (refined=false) when there is no AI binding', async () => {
    const r = await refinePromptText('summarize this', undefined);
    expect(r).toEqual({ proposed: 'summarize this', refined: false });
  });

  it('returns the improved text (refined=true) when the model rewrites it', async () => {
    const r = await refinePromptText('summarize', aiReturning('Summarize the key activity and what needs my attention.'));
    expect(r.refined).toBe(true);
    expect(r.proposed).toMatch(/needs my attention/);
  });

  it('strips surrounding quotes the model may add', async () => {
    const r = await refinePromptText('digest', aiReturning('"Draft a concise digest of the work in this scope."'));
    expect(r.proposed.startsWith('"')).toBe(false);
    expect(r.proposed.endsWith('"')).toBe(false);
  });

  it('degrades to the original when the model returns the SAME text', async () => {
    const r = await refinePromptText('summarize this', aiReturning('summarize this'));
    expect(r).toEqual({ proposed: 'summarize this', refined: false });
  });

  it('degrades to the original on a degenerate (too-short) rewrite', async () => {
    const r = await refinePromptText('summarize the situation', aiReturning('ok'));
    expect(r.refined).toBe(false);
    expect(r.proposed).toBe('summarize the situation');
  });

  it('NEVER throws — a model error returns the original', async () => {
    const r = await refinePromptText('summarize', aiThrowing);
    expect(r).toEqual({ proposed: 'summarize', refined: false });
  });

  it('rejects an over-long input up front (no LLM call)', async () => {
    const long = 'x'.repeat(601);
    const r = await refinePromptText(long, aiReturning('something'));
    expect(r).toEqual({ proposed: long, refined: false });
  });
});
