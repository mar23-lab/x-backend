import { describe, expect, it } from 'vitest';
import corpus from '../__fixtures__/action-intent-corpus.json';
import { classifyActionIntent } from '../lib/action-intent';

describe('action-intent shadow classifier', () => {
  it('meets overall accuracy and per-class recall floors without role/skill inference', () => {
    const cases = Object.entries(corpus).flatMap(([expected, prompts]) =>
      (prompts as string[]).map((prompt) => ({ expected, prompt })),
    );
    const correct = cases.filter(({ expected, prompt }) => classifyActionIntent(prompt).action_intent === expected).length;
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(correct / cases.length).toBeGreaterThanOrEqual(0.95);
    for (const [expected, prompts] of Object.entries(corpus)) {
      const matches = (prompts as string[]).filter((prompt) => classifyActionIntent(prompt).action_intent === expected).length;
      expect(matches / prompts.length, `${expected} recall`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('fails closed on empty and ambiguous input', () => {
    expect(classifyActionIntent('').action_intent).toBe('unresolved');
    expect(classifyActionIntent('banana').action_intent).toBe('unresolved');
  });
});
