import { describe, expect, it, vi } from 'vitest';
import { answerLiveCockpitChat, type CockpitChatFacts } from '../services/cockpit-chat';
import type { EffectiveRuntimePlan } from '../services/model-runtime-execution';

const facts: CockpitChatFacts = {
  events: [], total: 0,
  scope: { workspace_id: 'ws-1', project_id: null, domain_id: null },
};

function plan(run: ReturnType<typeof vi.fn>): EffectiveRuntimePlan {
  return {
    primary: {
      runtime_id: 'platform:workers_ai', provider: 'workers_ai', model: '@cf/test',
      source: 'platform_default', provider_config_version_id: null, base_url: null,
      credential: null, ai: { run },
    },
    fallbacks: [],
    resolution_attempts: [{
      source: 'platform_default', runtime_id: 'platform:workers_ai', provider: 'workers_ai',
      outcome: 'selected', code: null,
    }],
  };
}

describe('live chat capability integration', () => {
  it('uses compressed prompts and returns the replay receipt', async () => {
    const run = vi.fn(async () => ({ response: 'The live workspace record contains no current events, so there is no work state to report.', usage: {} }));
    const result = await answerLiveCockpitChat('What is happening?', facts, 'ask', undefined, plan(run), async () => ({
      system: 'compressed system', user: 'compressed user',
      receipt: {
        capability: 'headroom', tool_version: '0.34.0', source_hash: 'source', output_hash: 'output',
        latency_ms: 4, replayable: true, tokens_before: 100, tokens_after: 40,
        token_reduction_pct: 60, transforms_applied: ['deduplicate'], redaction_count: 0,
        protected_fragment_count: 2,
      },
    }));
    expect(run).toHaveBeenCalledWith('@cf/test', expect.objectContaining({
      messages: [{ role: 'system', content: 'compressed system' }, { role: 'user', content: 'compressed user' }],
    }));
    expect(result.execution.compression).toMatchObject({ capability: 'headroom', replayable: true });
  });

  it('preserves live execution with the original prompt when compression alone fails', async () => {
    const run = vi.fn(async () => ({ response: 'The live workspace record contains no current events, so there is no work state to report.', usage: {} }));
    const result = await answerLiveCockpitChat('What is happening?', facts, 'ask', undefined, plan(run), async () => {
      throw new Error('adapter unavailable');
    });
    const request = run.mock.calls[0][1] as { messages: Array<{ content: string }> };
    expect(request.messages[1].content).toContain('Operator question: What is happening?');
    expect(result.execution.compression).toBeNull();
    expect(result.generated_by).toBe('llm');
  });
});
