// onboarding-welcome.test.ts · 2026-06-08
//
// Unit tests for buildOnboardingWelcomeDraft — the DAY-1 governed welcome draft posted into a
// freshly provisioned workspace (the moat visible at minute one). Asserts: it is governed +
// never-throws, picks the right ONE first action from the real state (0 sources → "connect"; else
// → "review roadmap"), LLM-enriches when an AI binding is present and falls back to deterministic
// otherwise, and never leaks internal vocabulary into the customer-facing body.

import { describe, it, expect, vi } from 'vitest';
import { buildOnboardingWelcomeDraft } from '../services/agent-digest';
import type { WorkspaceActivitySummary } from '../dal/workspace-activity-store';

function summary(over: Partial<WorkspaceActivitySummary> = {}): WorkspaceActivitySummary {
  return {
    workspace_id: 'ws1', events_total: 4, events_completed: 0, signoffs_total: 0, projects_total: 1,
    connected_sources: 0, first_activity_at: null, last_activity_at: null, days_of_history: 0,
    needs_you: 4, since: null, events_since: 0, signoffs_since: 0,
    ...over,
  };
}

describe('buildOnboardingWelcomeDraft', () => {
  it('produces a deterministic welcome (no AI) naming the workspace', async () => {
    const d = await buildOnboardingWelcomeDraft(summary(), { customerName: 'Honest & Young', roadmapCount: 4 });
    expect(d.generated_by).toBe('deterministic');
    expect(d.summary).toMatch(/Honest & Young/);
    expect(d.body).toMatch(/Welcome to Honest & Young/);
    // it is a WELCOME, not a generic digest snapshot
    expect(d.body).not.toMatch(/Here is a snapshot of your workspace/);
    // day-1 state bullets reflect the real numbers
    expect(d.body).toMatch(/4 roadmap items queued/);
    expect(d.body).toMatch(/1 project set up/);
  });

  it('picks "connect" as the first action when connected_sources === 0', async () => {
    const d = await buildOnboardingWelcomeDraft(summary({ connected_sources: 0 }), { customerName: 'Acme' });
    expect(d.body).toMatch(/Connect your first source to start capturing evidence/);
    expect(d.body).not.toMatch(/Review your day-1 roadmap/);
  });

  it('picks "review roadmap" as the first action when sources are connected', async () => {
    const d = await buildOnboardingWelcomeDraft(summary({ connected_sources: 2 }), { customerName: 'Acme' });
    expect(d.body).toMatch(/Review your day-1 roadmap and approve the first item/);
    expect(d.body).not.toMatch(/Connect your first source/);
    expect(d.body).toMatch(/2 connected sources feeding in evidence/);
  });

  it('is a PENDING proposal — the body carries the approve/reject governance footer', async () => {
    const d = await buildOnboardingWelcomeDraft(summary(), { customerName: 'Acme' });
    expect(d.body).toMatch(/Approve to post this welcome .* as a governed record, or reject to discard/);
  });

  it('LLM-enriches the body when an AI binding is present', async () => {
    const ai = {
      run: async () => ({
        response: 'Welcome to Acme — your workspace is set up and ready to go. There are four day-one items queued for you. Connect your first source to start capturing evidence.',
      }),
    };
    const d = await buildOnboardingWelcomeDraft(summary(), { customerName: 'Acme', roadmapCount: 4, ai });
    expect(d.generated_by).toBe('llm');
    expect(d.body).toMatch(/your workspace is set up and ready to go/);
    // governance footer still appended to the LLM draft
    expect(d.body).toMatch(/Approve to post this welcome/);
  });

  it('falls back to deterministic when the LLM returns too little text', async () => {
    const ai = { run: async () => ({ response: 'hi' }) };
    const d = await buildOnboardingWelcomeDraft(summary(), { customerName: 'Acme', ai });
    expect(d.generated_by).toBe('deterministic');
    expect(d.body).toMatch(/Welcome to Acme/);
  });

  it('NEVER throws when the AI binding throws — degrades to deterministic', async () => {
    const ai = { run: async () => { throw new Error('AI boom'); } };
    const d = await buildOnboardingWelcomeDraft(summary(), { customerName: 'Acme', ai });
    expect(d.generated_by).toBe('deterministic');
    expect(d.body).toMatch(/Welcome to Acme/);
  });

  it('NEVER throws on malformed input (missing name, negative/NaN roadmap count)', async () => {
    const d = await buildOnboardingWelcomeDraft(
      summary(),
      { customerName: '', roadmapCount: Number.NaN },
    );
    expect(d.generated_by).toBe('deterministic');
    // a safe generic name is used when none is supplied
    expect(d.summary).toMatch(/your workspace/);
    // no roadmap-count bullet when the count is not a positive number
    expect(d.body).not.toMatch(/roadmap item/);
  });

  it('keeps the body customer-safe — no internal vocabulary leaks', async () => {
    const d = await buildOnboardingWelcomeDraft(summary(), { customerName: 'Honest & Young', roadmapCount: 4 });
    const internal = /\bMB-?P\b|\bxcp[-_]|role-route:|\bWI-\d|packet-\d|\bx-biz\b|Marat/i;
    expect(d.body).not.toMatch(internal);
    expect(d.summary).not.toMatch(internal);
  });

  it('records completed and fallback terminal states through the execution observer', async () => {
    const finish = vi.fn(async () => undefined);
    const executionObserver = { start: vi.fn(async () => ({ complete: finish })) };
    const rich = 'Welcome to Acme. Your workspace is ready, the first governed work items are visible, and your next safe action is to connect a source.';

    await buildOnboardingWelcomeDraft(summary(), {
      customerName: 'Acme',
      ai: { run: async () => ({ response: rich }) },
      executionObserver,
    });
    expect(finish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }));

    await buildOnboardingWelcomeDraft(summary(), {
      customerName: 'Acme',
      ai: { run: async () => { throw new Error('down'); } },
      executionObserver,
    });
    expect(finish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'fallback', error_code: 'MODEL_ERROR' }));
  });
});
