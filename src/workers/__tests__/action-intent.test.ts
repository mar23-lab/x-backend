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

  it('does not reinterpret a read-only guardrail as a write request', () => {
    const prompt = 'What is currently in this workspace? Summarize the active projects, connected sources, and recorded events. State what is grounded, include freshness, and do not create or change anything.';
    expect(classifyActionIntent(prompt)).toMatchObject({ action_intent: 'answer', matched_rule: 'answer' });
    expect(classifyActionIntent('Inspect the current state without creating anything.')).toMatchObject({ action_intent: 'inspect' });
    expect(classifyActionIntent('Live verification 2026-07-24: summarize the current workspace status and identify any blocked work. Do not create, approve, edit, or delete governed work.')).toMatchObject({ action_intent: 'inspect', matched_rule: 'inspect' });
    expect(classifyActionIntent('What is the current status of Honest & Young Operations? Summarize active work and blockers using workspace records. Read only: do not create or modify work.')).toMatchObject({ action_intent: 'inspect', matched_rule: 'inspect' });
    expect(classifyActionIntent('Create a task and do not duplicate existing work.')).toMatchObject({ action_intent: 'create_work' });
    expect(classifyActionIntent('Create a read-only report showing current status.')).toMatchObject({ action_intent: 'create_work' });
    expect(classifyActionIntent('Do not wait; create a task now.')).toMatchObject({ action_intent: 'create_work' });
  });
});
