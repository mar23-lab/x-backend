import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderUnavailableError,
  RuntimeCapabilityError,
  RuntimePreferenceError,
  executeEffectiveRuntimePlan,
  resolveEffectiveRuntimePlan,
  type EffectiveRuntimePlan,
  type ResolvedRuntime,
} from '../services/model-runtime-execution';
import { encryptCredential } from '../lib/model-runtime-crypto';
import { PLATFORM_WORKERS_AI_MODEL } from '../services/model-runtime-capabilities';

const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff)));
const TENANT_KEY = 'tenant-provider-key-not-real';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'runtime_default', provider: 'anthropic', auth_kind: 'api_key', base_url: null,
  model: 'claude-live', credential_last4: 'test', enabled: true, is_default: true,
  created_by: 'owner', created_at: '2026-08-08T00:00:00Z', updated_at: '2026-08-08T00:00:00Z',
  ...over,
});

function facade(
  rows: any[],
  override: string | null,
  sealed: Awaited<ReturnType<typeof encryptCredential>> | Record<string, Awaited<ReturnType<typeof encryptCredential>>> | null = null,
) {
  return {
    listProviders: vi.fn(async () => rows),
    getOverride: vi.fn(async () => override),
    getProviderCredential: vi.fn(async (_workspace: string, provider: string) => {
      if (!sealed) return null;
      if ('ciphertext' in sealed) return sealed;
      return sealed[provider] ?? null;
    }),
    upsertProvider: vi.fn(), deleteProvider: vi.fn(), setDefaultProvider: vi.fn(), setOverride: vi.fn(), clearOverride: vi.fn(),
  } as any;
}

afterEach(() => vi.restoreAllMocks());

describe('effective model-runtime resolution', () => {
  it('uses the current governed Workers AI model for the managed platform default', async () => {
    const plan = await resolveEffectiveRuntimePlan({
      facade: facade([], null),
      env: { AI: { run: async () => ({ response: 'A live managed response long enough for chat.' }) } },
      userId: 'user_a', workspaceId: 'workspace_a',
    });
    expect(plan.primary).toMatchObject({
      runtime_id: 'platform:workers_ai',
      model: PLATFORM_WORKERS_AI_MODEL,
    });
    expect(PLATFORM_WORKERS_AI_MODEL).toBe('@cf/zai-org/glm-4.7-flash');
  });

  it('honours user override before workspace default and keeps only live platform fallbacks', async () => {
    const sealed = await encryptCredential(KEY, JSON.stringify({ api_key: TENANT_KEY }));
    const userRuntime = row({ id: 'runtime_user', model: 'claude-user', is_default: false });
    const workspaceRuntime = row();
    const plan = await resolveEffectiveRuntimePlan({
      facade: facade([workspaceRuntime, userRuntime], 'runtime_user', sealed),
      env: {
        MODEL_RUNTIME_ENC_KEY: KEY,
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

  it('skips a broken user override credential and selects the valid workspace default', async () => {
    const userRuntime = row({ id: 'runtime_user', provider: 'anthropic', model: 'claude-user', is_default: false });
    const workspaceRuntime = row({ id: 'runtime_default', provider: 'openai', model: 'gpt-4o-mini', is_default: true });
    const openai = await encryptCredential(KEY, JSON.stringify({ api_key: TENANT_KEY }));
    const plan = await resolveEffectiveRuntimePlan({
      facade: facade([workspaceRuntime, userRuntime], 'runtime_user', { openai }),
      env: { MODEL_RUNTIME_ENC_KEY: KEY },
      userId: 'user_a',
      workspaceId: 'workspace_a',
    });

    expect(plan.primary).toMatchObject({
      runtime_id: 'runtime_default', provider: 'openai', source: 'workspace_default',
    });
    expect(plan.resolution_attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime_id: 'runtime_user', outcome: 'skipped', code: 'STORED_CREDENTIAL_UNAVAILABLE' }),
      expect.objectContaining({ runtime_id: 'runtime_default', outcome: 'selected', code: null }),
    ]));
  });

  it('records relay-required configured providers and selects an existing live platform path', async () => {
    const configured = row({ provider: 'ollama' });
    const plan = await resolveEffectiveRuntimePlan({
      facade: facade([configured], null),
      env: { AI: { run: async () => ({ response: 'live Workers AI response long enough for chat' }) } },
      userId: 'user_a', workspaceId: 'workspace_a',
    });

    expect(plan.primary.runtime_id).toBe('platform:workers_ai');
    expect(plan.resolution_attempts).toContainEqual(expect.objectContaining({
      runtime_id: 'runtime_default', outcome: 'skipped', code: 'RELAY_REQUIRED',
    }));
  });

  it('fails closed when neither configured nor platform live runtime is executable', async () => {
    await expect(resolveEffectiveRuntimePlan({
      facade: facade([], null), env: {}, userId: 'user_a', workspaceId: 'workspace_a',
    })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('decrypts the stored tenant credential for execution and never substitutes the platform secret', async () => {
    const sealed = await encryptCredential(KEY, JSON.stringify({ api_key: TENANT_KEY }));
    const runtimes = facade([row()], null, sealed);
    const plan = await resolveEffectiveRuntimePlan({
      facade: runtimes,
      env: { MODEL_RUNTIME_ENC_KEY: KEY, ANTHROPIC_API_KEY: 'platform-anthropic-key' },
      userId: 'user_a', workspaceId: 'workspace_a',
    });
    expect(runtimes.getProviderCredential).toHaveBeenCalledWith('workspace_a', 'anthropic');
    expect(plan.primary.runtime_id).toBe('runtime_default');
    expect(JSON.stringify(plan.primary)).toContain(TENANT_KEY);
  });

  it('validates a request runtime preference within the tenant and rejects foreign ids', async () => {
    const sealed = await encryptCredential(KEY, JSON.stringify({ api_key: TENANT_KEY }));
    const plan = await resolveEffectiveRuntimePlan({
      facade: facade([row({ id: 'tenant_runtime' })], null, sealed),
      env: { MODEL_RUNTIME_ENC_KEY: KEY }, userId: 'u', workspaceId: 'w', runtimeId: 'tenant_runtime',
    });
    expect(plan.primary.source).toBe('request_preference');
    await expect(resolveEffectiveRuntimePlan({
      facade: facade([], null), env: {}, userId: 'u', workspaceId: 'w', runtimeId: 'foreign_runtime',
    })).rejects.toBeInstanceOf(RuntimePreferenceError);
  });

  it('accepts an available governed platform runtime preference and keeps other live runtimes as fallbacks', async () => {
    const plan = await resolveEffectiveRuntimePlan({
      facade: facade([], null),
      env: {
        AI: { run: async () => ({ response: 'live Workers AI fallback response long enough for chat' }) },
        ANTHROPIC_API_KEY: 'platform-anthropic-key',
      },
      userId: 'u', workspaceId: 'w', runtimeId: 'platform:anthropic',
    });

    expect(plan.primary).toMatchObject({
      runtime_id: 'platform:anthropic', provider: 'anthropic', source: 'request_preference',
    });
    expect(plan.fallbacks.map((runtime) => runtime.runtime_id)).toContain('platform:workers_ai');
  });

  it('rejects an unavailable platform runtime preference instead of silently changing providers', async () => {
    await expect(resolveEffectiveRuntimePlan({
      facade: facade([], null),
      env: { AI: { run: async () => ({ response: 'live Workers AI response long enough for chat' }) } },
      userId: 'u', workspaceId: 'w', runtimeId: 'platform:anthropic',
    })).rejects.toBeInstanceOf(RuntimePreferenceError);
  });

  it('returns RELAY_REQUIRED without fetching an arbitrary local/custom URL', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(resolveEffectiveRuntimePlan({
      facade: facade([row({ id: 'local_runtime', provider: 'custom', base_url: 'http://10.0.0.8:9000' })], null),
      env: {}, userId: 'u', workspaceId: 'w', runtimeId: 'local_runtime',
    })).rejects.toBeInstanceOf(RuntimeCapabilityError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ADAPTER_UNAVAILABLE for Bedrock until a reviewed SigV4 adapter exists', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(resolveEffectiveRuntimePlan({
      facade: facade([row({ id: 'bedrock_runtime', provider: 'aws_bedrock' })], null),
      env: {}, userId: 'u', workspaceId: 'w', runtimeId: 'bedrock_runtime',
    })).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE', status: 503 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('live provider dispatch', () => {
  it('accepts the OpenAI-compatible response shape returned by current Workers AI chat models', async () => {
    const run = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'A live GLM answer from the current Workers AI contract.' } }],
      usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 },
    }));
    const runtime: ResolvedRuntime = {
      runtime_id: 'platform:workers_ai', provider: 'workers_ai', model: PLATFORM_WORKERS_AI_MODEL,
      source: 'platform_default', provider_config_version_id: null, base_url: null, credential: null,
      ai: { run },
    };

    const result = await executeEffectiveRuntimePlan({
      plan: { primary: runtime, fallbacks: [], resolution_attempts: [] },
      system: 'Grounded only.', user: 'Summarise.', maxTokens: 100,
    });

    expect(result.text).toBe('A live GLM answer from the current Workers AI contract.');
    expect(result.usage).toEqual({ tokens_in: 11, tokens_out: 9 });
    expect(result.attempts).toEqual([expect.objectContaining({ status: 'completed', error_code: null })]);
    expect(run).toHaveBeenCalledWith(PLATFORM_WORKERS_AI_MODEL, expect.objectContaining({
      max_completion_tokens: 100,
      chat_template_kwargs: { enable_thinking: false },
    }));
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty('max_tokens');
  });

  it('dispatches the effective Anthropic runtime and returns usage plus provenance', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'A live Anthropic answer grounded in the supplied Xlooop context.' }],
      usage: { input_tokens: 17, output_tokens: 13 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const runtime: ResolvedRuntime = {
      runtime_id: 'runtime_anthropic', provider: 'anthropic', model: 'claude-live', source: 'workspace_default',
      provider_config_version_id: 'model-runtime-provider:runtime_anthropic:v1', base_url: null,
      credential: { api_key: TENANT_KEY },
    };

    const result = await executeEffectiveRuntimePlan({
      plan: { primary: runtime, fallbacks: [], resolution_attempts: [] },
      system: 'Grounded only.', user: 'Summarise.', maxTokens: 100,
    });

    expect(fetchSpy).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.any(Object));
    expect(result.text).toContain('live Anthropic answer');
    expect(result.usage).toEqual({ tokens_in: 17, tokens_out: 13 });
    expect(result.attempts).toEqual([expect.objectContaining({ status: 'completed', provider: 'anthropic' })]);
    expect(JSON.stringify(result)).not.toContain(TENANT_KEY);
  });

  it('uses only live fallbacks and never manufactures deterministic assistant text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const primary: ResolvedRuntime = {
      runtime_id: 'runtime_anthropic', provider: 'anthropic', model: 'claude-live', source: 'workspace_default',
      provider_config_version_id: 'v1', base_url: null, credential: { api_key: TENANT_KEY },
    };
    const fallback: ResolvedRuntime = {
      runtime_id: 'platform:workers_ai', provider: 'workers_ai', model: '@cf/test', source: 'platform_default',
      provider_config_version_id: null, base_url: null, credential: null,
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

  it('treats a semantic validation failure as a provider failure and retries a live fallback', async () => {
    const runtime = (id: string, response: string): ResolvedRuntime => ({
      runtime_id: id, provider: 'workers_ai', model: '@cf/test', source: 'platform_default',
      provider_config_version_id: null, base_url: null, credential: null,
      ai: { run: async () => ({ response }) },
    });
    const result = await executeEffectiveRuntimePlan({
      plan: {
        primary: runtime('unsafe', 'An unsafe current-state answer long enough to pass the length gate.'),
        fallbacks: [runtime('safe', 'A source-bounded answer that passes semantic validation safely.')],
        resolution_attempts: [],
      },
      system: 'Grounded only.', user: 'Summarise.', maxTokens: 100,
      validateText: (text) => text.includes('unsafe') ? 'GROUNDING_VALIDATION_FAILED' : null,
    });

    expect(result.runtime.runtime_id).toBe('safe');
    expect(result.attempts).toEqual([
      expect.objectContaining({ runtime_id: 'unsafe', status: 'failed', error_code: 'GROUNDING_VALIDATION_FAILED' }),
      expect.objectContaining({ runtime_id: 'safe', status: 'completed' }),
    ]);
  });

  it('accepts a valid concise live response instead of reporting a provider outage', async () => {
    const runtime: ResolvedRuntime = {
      runtime_id: 'platform:workers_ai', provider: 'workers_ai', model: '@cf/test', source: 'platform_default',
      provider_config_version_id: null, base_url: null, credential: null,
      ai: { run: async () => ({ response: 'Honest & Young.' }) },
    };
    const result = await executeEffectiveRuntimePlan({
      plan: { primary: runtime, fallbacks: [], resolution_attempts: [] },
      system: 'Answer from the supplied facts.', user: 'What is the workspace name?', maxTokens: 32,
      validateText: () => null,
    });

    expect(result.text).toBe('Honest & Young.');
    expect(result.attempts).toEqual([
      expect.objectContaining({ status: 'completed', error_code: null }),
    ]);
  });

  it('still rejects an empty live provider response', async () => {
    const runtime: ResolvedRuntime = {
      runtime_id: 'platform:workers_ai', provider: 'workers_ai', model: '@cf/test', source: 'platform_default',
      provider_config_version_id: null, base_url: null, credential: null,
      ai: { run: async () => ({ response: '   ' }) },
    };
    await expect(executeEffectiveRuntimePlan({
      plan: { primary: runtime, fallbacks: [], resolution_attempts: [] },
      system: 'Answer.', user: 'Question.', maxTokens: 32,
    })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      attempts: [expect.objectContaining({ status: 'failed', error_code: 'EMPTY_RESPONSE' })],
    });
  });

  it('returns typed provider-unavailable when every live provider fails', async () => {
    const runtime: ResolvedRuntime = {
      runtime_id: 'platform:workers_ai', provider: 'workers_ai', model: '@cf/test', source: 'platform_default',
      provider_config_version_id: null, base_url: null, credential: null,
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

describe('cloud provider request contracts', () => {
  const openAiCases = [
    ['openai', 'https://api.openai.com/v1/chat/completions', 'authorization'],
    ['mistral', 'https://api.mistral.ai/v1/chat/completions', 'authorization'],
    ['deepseek', 'https://api.deepseek.com/chat/completions', 'authorization'],
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', 'authorization'],
  ] as const;

  for (const [provider, url, authHeader] of openAiCases) {
    it(`${provider} uses its fixed cloud endpoint and tenant bearer credential`, async () => {
      const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
        expect(_url).toBe(url);
        expect((init.headers as Record<string, string>)[authHeader]).toBe(`Bearer ${TENANT_KEY}`);
        expect(JSON.parse(String(init.body))).toMatchObject({ model: 'model-live' });
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'A live provider response with enough text for validation.' } }],
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchSpy);
      const runtime: ResolvedRuntime = {
        runtime_id: `runtime_${provider}`, provider, model: 'model-live', source: 'workspace_default',
        provider_config_version_id: 'v1', base_url: null, credential: { api_key: TENANT_KEY },
      };
      const result = await executeEffectiveRuntimePlan({
        plan: { primary: runtime, fallbacks: [], resolution_attempts: [] },
        system: 'System.', user: 'User.', maxTokens: 64,
      });
      expect(result.runtime.provider).toBe(provider);
      expect(JSON.stringify(result)).not.toContain(TENANT_KEY);
    });
  }

  it('Google Gemini uses x-goog-api-key and native generateContent shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain('/v1beta/models/gemini-live:generateContent');
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(TENANT_KEY);
      expect(JSON.parse(String(init.body))).toMatchObject({
        system_instruction: { parts: [{ text: 'System.' }] },
        contents: [{ role: 'user', parts: [{ text: 'User.' }] }],
      });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'A live Gemini response with enough text for validation.' }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 },
      }), { status: 200 });
    }));
    const runtime: ResolvedRuntime = {
      runtime_id: 'runtime_google', provider: 'google', model: 'gemini-live', source: 'workspace_default',
      provider_config_version_id: 'v1', base_url: null, credential: { api_key: TENANT_KEY },
    };
    await executeEffectiveRuntimePlan({
      plan: { primary: runtime, fallbacks: [], resolution_attempts: [] },
      system: 'System.', user: 'User.', maxTokens: 64,
    });
  });

  it('Azure OpenAI accepts only allowlisted Azure hosts and uses api-key auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://tenant.openai.azure.com/openai/v1/chat/completions');
      expect((init.headers as Record<string, string>)['api-key']).toBe(TENANT_KEY);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'A live Azure response with enough text for validation.' } }],
      }), { status: 200 });
    }));
    const runtime: ResolvedRuntime = {
      runtime_id: 'runtime_azure', provider: 'azure_openai', model: 'deployment-one', source: 'workspace_default',
      provider_config_version_id: 'v1', base_url: 'https://tenant.openai.azure.com',
      credential: { api_key: TENANT_KEY, deployment: 'deployment-one' },
    };
    await executeEffectiveRuntimePlan({
      plan: { primary: runtime, fallbacks: [], resolution_attempts: [] },
      system: 'System.', user: 'User.', maxTokens: 64,
    });

    vi.stubGlobal('fetch', vi.fn());
    await expect(executeEffectiveRuntimePlan({
      plan: { primary: { ...runtime, base_url: 'http://127.0.0.1:8787' }, fallbacks: [], resolution_attempts: [] },
      system: 'System.', user: 'User.', maxTokens: 64,
    })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
