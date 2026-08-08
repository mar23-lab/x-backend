import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderUnavailableError,
  executeEffectiveRuntimePlan,
  resolveEffectiveRuntimePlan,
  type EffectiveRuntimePlan,
  type ResolvedRuntime,
} from '../services/model-runtime-execution';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'runtime_default', provider: 'anthropic', auth_kind: 'api_key', base_url: null,
  model: 'claude-live', credential_last4: 'test', enabled: true, is_default: true,
  created_by: 'owner', created_at: '2026-08-08T00:00:00Z', updated_at: '2026-08-08T00:00:00Z',
  ...over,
});

function facade(rows: any[], override: string | null) {
  return {
    listProviders: vi.fn(async () => rows),
    getOverride: vi.fn(async () => override),
    getProviderCredential: vi.fn(async () => null),
    upsertProvider: vi.fn(), deleteProvider: vi.fn(), setDefaultProvider: vi.fn(), setOverride: vi.fn(),
  } as any;
}

afterEach(() => vi.restoreAllMocks());

describe('effective model-runtime resolution', () => {
  it('honours user override before workspace default and keeps only live platform fallbacks', async () => {
    const userRuntime = row({ id: 'runtime_user', model: 'claude-user', is_default: false });
    const workspaceRuntime = row();
    const plan = await resolveEffectiveRuntimePlan({
      facade: facade([workspaceRuntime, userRuntime], 'runtime_user'),
      env: {
        ANTHROPIC_API_KEY: 'platform-anthropic-key',
        AI: { run: async () => ({ response: 'live Workers AI fallback response long enough for chat' }) },
      },
      userId: 'user_a', workspaceId: 'workspace_a',
    });

    expect(plan.primary).toMatchObject({
      runtime_id: 'runtime_user', provider: 'anthropic', model: 'claude-user', source: 'user_override',
    });
    expect(plan.fallbacks.map((runtime) => runtime.runtime_id)).toEqual([
      'runtime_default', 'platform:workers_ai', 'platform:anthropic',
    ]);
  });

  it('records unsupported configured providers and selects an existing live platform path', async () => {
    const configured = row({ provider: 'openai' });
    const plan = await resolveEffectiveRuntimePlan({
      facade: facade([configured], null),
      env: { AI: { run: async () => ({ response: 'live Workers AI response long enough for chat' }) } },
      userId: 'user_a', workspaceId: 'workspace_a',
    });

    expect(plan.primary.runtime_id).toBe('platform:workers_ai');
    expect(plan.resolution_attempts).toContainEqual(expect.objectContaining({
      runtime_id: 'runtime_default', outcome: 'skipped', code: 'PROVIDER_ADAPTER_UNAVAILABLE',
    }));
  });

  it('fails closed when neither configured nor platform live runtime is executable', async () => {
    await expect(resolveEffectiveRuntimePlan({
      facade: facade([], null), env: {}, userId: 'user_a', workspaceId: 'workspace_a',
    })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('does not read tenant credential ciphertext while resolving chat execution', async () => {
    const runtimes = facade([row()], null);
    await resolveEffectiveRuntimePlan({
      facade: runtimes,
      env: { ANTHROPIC_API_KEY: 'platform-anthropic-key' },
      userId: 'user_a', workspaceId: 'workspace_a',
    });
    expect(runtimes.getProviderCredential).not.toHaveBeenCalled();
  });
});

describe('live provider dispatch', () => {
  it('dispatches the effective Anthropic runtime and returns usage plus provenance', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'A live Anthropic answer grounded in the supplied Xlooop context.' }],
      usage: { input_tokens: 17, output_tokens: 13 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const runtime: ResolvedRuntime = {
      runtime_id: 'runtime_anthropic', provider: 'anthropic', model: 'claude-live', source: 'workspace_default',
      provider_config_version_id: 'model-runtime-provider:runtime_anthropic:v1', credential: 'platform-key',
    };

    const result = await executeEffectiveRuntimePlan({
      plan: { primary: runtime, fallbacks: [], resolution_attempts: [] },
      system: 'Grounded only.', user: 'Summarise.', maxTokens: 100,
    });

    expect(fetchSpy).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.any(Object));
    expect(result.text).toContain('live Anthropic answer');
    expect(result.usage).toEqual({ tokens_in: 17, tokens_out: 13 });
    expect(result.attempts).toEqual([expect.objectContaining({ status: 'completed', provider: 'anthropic' })]);
  });

  it('uses only live fallbacks and never manufactures deterministic assistant text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const primary: ResolvedRuntime = {
      runtime_id: 'runtime_anthropic', provider: 'anthropic', model: 'claude-live', source: 'workspace_default',
      provider_config_version_id: 'v1', credential: 'platform-key',
    };
    const fallback: ResolvedRuntime = {
      runtime_id: 'platform:workers_ai', provider: 'workers_ai', model: '@cf/test', source: 'platform_default',
      provider_config_version_id: null, credential: null,
      ai: { run: async () => ({ response: 'A live Workers AI fallback response grounded in the supplied context.' }) },
    };
    const plan: EffectiveRuntimePlan = { primary, fallbacks: [fallback], resolution_attempts: [] };

    const result = await executeEffectiveRuntimePlan({
      plan, system: 'Grounded only.', user: 'Summarise.', maxTokens: 100,
    });

    expect(result.runtime.provider).toBe('workers_ai');
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed']);
    expect(result.text).not.toMatch(/deterministic|fixture/i);
  });

  it('returns typed provider-unavailable when every live provider fails', async () => {
    const runtime: ResolvedRuntime = {
      runtime_id: 'platform:workers_ai', provider: 'workers_ai', model: '@cf/test', source: 'platform_default',
      provider_config_version_id: null, credential: null,
      ai: { run: async () => { throw new Error('upstream unavailable'); } },
    };
    await expect(executeEffectiveRuntimePlan({
      plan: { primary: runtime, fallbacks: [], resolution_attempts: [] },
      system: 'Grounded only.', user: 'Summarise.', maxTokens: 100,
    })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', status: 503,
      attempts: [expect.objectContaining({ status: 'failed' })],
    });
  });
});
