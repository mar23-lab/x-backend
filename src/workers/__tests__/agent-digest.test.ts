// agent-digest.test.ts · 2026-06-08
// Unit tests for the governed digest generator (buildWorkspaceDigest).

import { describe, it, expect } from 'vitest';
import { buildWorkspaceDigest, buildWorkspaceDigestLLM, type AiRunner } from '../services/agent-digest';

const SUMMARY = (over: Record<string, unknown> = {}) => ({
  workspace_id: 'ws1', events_total: 42, events_completed: 30, signoffs_total: 12, projects_total: 4,
  connected_sources: 2, first_activity_at: '2026-05-01T00:00:00Z', last_activity_at: '2026-06-06T00:00:00Z',
  days_of_history: 37, needs_you: 3, since: '2026-06-05T00:00:00Z', events_since: 5, signoffs_since: 1, ...over,
});

describe('buildWorkspaceDigest', () => {
  it('includes the headline counts', () => {
    const d = buildWorkspaceDigest(SUMMARY());
    expect(d.summary).toMatch(/42 events on record/);
    expect(d.body).toMatch(/42 events on record \(30 completed\)/);
    expect(d.body).toMatch(/12 sign-offs/);
    expect(d.body).toMatch(/4 projects · 2 connected sources/);
    expect(d.body).toMatch(/Approve to post this digest/);
  });

  it('includes needs-you + since-you-left when present', () => {
    const d = buildWorkspaceDigest(SUMMARY());
    expect(d.body).toMatch(/3 items awaiting your review/);
    expect(d.body).toMatch(/5 new events since you were last here/);
  });

  it('omits needs-you / since when zero', () => {
    const d = buildWorkspaceDigest(SUMMARY({ needs_you: 0, events_since: 0, since: null }));
    expect(d.body).not.toMatch(/awaiting your review/);
    expect(d.body).not.toMatch(/since you were last here/);
  });

  it('handles singular grammar', () => {
    const d = buildWorkspaceDigest(SUMMARY({ events_total: 1, projects_total: 1, connected_sources: 1, days_of_history: 1, signoffs_total: 1 }));
    expect(d.body).toMatch(/1 event on record/);
    expect(d.body).toMatch(/1 project · 1 connected source/);
    expect(d.body).toMatch(/1 day of history/);
  });
});

describe('buildWorkspaceDigestLLM (governed LLM draft + fail-safe fallback)', () => {
  const RICH = 'Your workspace had a productive week: 42 events on record with 30 completed, 12 sign-offs across 4 projects, and a strong audit trail over 37 days. Three items still await your review. Next: clear the three items awaiting your sign-off.';

  it('falls back to the deterministic digest when there is NO AI binding', async () => {
    const d = await buildWorkspaceDigestLLM(SUMMARY());
    expect(d.generated_by).toBe('deterministic');
    expect(d.body).toMatch(/42 events on record \(30 completed\)/);
  });

  it('uses the LLM draft when the binding returns usable text, preserving the approve footer', async () => {
    const ai: AiRunner = { run: async () => ({ response: RICH }) };
    const d = await buildWorkspaceDigestLLM(SUMMARY(), ai);
    expect(d.generated_by).toBe('llm');
    expect(d.body).toMatch(/productive week/);
    expect(d.body).toMatch(/Approve to post this digest/); // governed: still a pending proposal
  });

  it('falls back to deterministic when the AI binding THROWS (never 5xx)', async () => {
    const ai: AiRunner = { run: async () => { throw new Error('AI unavailable'); } };
    const d = await buildWorkspaceDigestLLM(SUMMARY(), ai);
    expect(d.generated_by).toBe('deterministic');
    expect(d.body).toMatch(/42 events on record/);
  });

  it('falls back to deterministic when the AI output is empty / too short', async () => {
    expect((await buildWorkspaceDigestLLM(SUMMARY(), { run: async () => ({ response: 'ok' }) })).generated_by).toBe('deterministic');
    expect((await buildWorkspaceDigestLLM(SUMMARY(), { run: async () => ({}) })).generated_by).toBe('deterministic');
  });

  it('instructs the model to use ONLY supplied facts + passes the real counts (no invention)', async () => {
    let system = '';
    let user = '';
    const ai: AiRunner = {
      run: async (_model, opts) => { system = opts.messages[0].content; user = opts.messages[1].content; return { response: RICH }; },
    };
    await buildWorkspaceDigestLLM(SUMMARY(), ai);
    expect(system).toMatch(/ONLY the facts/i);
    expect(system).toMatch(/never invent/i);
    expect(user).toMatch(/42 events on record, 30 completed/);
  });
});
