import type { ModelRuntimesFacade } from '../dal/model-runtime-facade';
import type { ProviderConfigRow } from '../dal/model-runtime-store';
import type { ModelExecutionObserver } from '../lib/model-execution-lineage';
import type { AiRunner } from './agent-digest';

export const PLATFORM_WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const PLATFORM_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const PROVIDER_TIMEOUT_MS = 30_000;

// Chat only dispatches adapters already implemented by cockpit-chat. Provider registry rows for
// other vendors remain configurable, but are not treated as executable until an adapter is shipped.
export type LiveRuntimeProvider = 'workers_ai' | 'anthropic';
export type RuntimeResolutionSource = 'user_override' | 'workspace_default' | 'platform_default';

export interface LiveRuntimeEnv {
  AI?: AiRunner;
  ANTHROPIC_API_KEY?: string;
}

export interface ResolvedRuntime {
  runtime_id: string;
  provider: LiveRuntimeProvider;
  model: string;
  source: RuntimeResolutionSource;
  provider_config_version_id: string | null;
  credential: string | null;
  ai?: AiRunner;
}

export interface RuntimeResolutionAttempt {
  source: RuntimeResolutionSource;
  runtime_id: string | null;
  provider: string | null;
  outcome: 'selected' | 'fallback' | 'skipped';
  code: string | null;
}

export interface EffectiveRuntimePlan {
  primary: ResolvedRuntime;
  fallbacks: ResolvedRuntime[];
  resolution_attempts: RuntimeResolutionAttempt[];
}

export interface RuntimeExecutionAttempt {
  runtime_id: string;
  provider: LiveRuntimeProvider;
  model: string;
  source: RuntimeResolutionSource;
  status: 'completed' | 'failed';
  error_code: string | null;
  latency_ms: number;
  execution_receipt_id: string | null;
}

export interface RuntimeExecutionResult {
  text: string;
  runtime: ResolvedRuntime;
  usage: { tokens_in: number | null; tokens_out: number | null };
  latency_ms: number;
  execution_receipt_id: string | null;
  attempts: RuntimeExecutionAttempt[];
}

export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  readonly status = 503;
  readonly attempts: RuntimeExecutionAttempt[];

  constructor(message = 'no live model runtime is available', attempts: RuntimeExecutionAttempt[] = []) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.attempts = attempts;
  }
}

function providerConfigVersion(row: ProviderConfigRow): string {
  return `model-runtime-provider:${row.id}:${row.updated_at}`;
}

function resolveConfiguredRow(
  row: ProviderConfigRow,
  source: Exclude<RuntimeResolutionSource, 'platform_default'>,
  env: LiveRuntimeEnv,
): { runtime?: ResolvedRuntime; code?: string } {
  if (!row.enabled) return { code: 'RUNTIME_DISABLED' };
  if (row.provider !== 'anthropic') return { code: 'PROVIDER_ADAPTER_UNAVAILABLE' };
  if (!env.ANTHROPIC_API_KEY) return { code: 'PLATFORM_CREDENTIAL_UNAVAILABLE' };
  return {
    runtime: {
      runtime_id: row.id,
      provider: 'anthropic',
      model: row.model?.trim() || PLATFORM_ANTHROPIC_MODEL,
      source,
      provider_config_version_id: providerConfigVersion(row),
      credential: env.ANTHROPIC_API_KEY,
    },
  };
}

function platformRuntimes(env: LiveRuntimeEnv): ResolvedRuntime[] {
  const runtimes: ResolvedRuntime[] = [];
  if (env.AI) {
    runtimes.push({
      runtime_id: 'platform:workers_ai',
      provider: 'workers_ai',
      model: PLATFORM_WORKERS_AI_MODEL,
      source: 'platform_default',
      provider_config_version_id: null,
      credential: null,
      ai: env.AI,
    });
  }
  if (env.ANTHROPIC_API_KEY) {
    runtimes.push({
      runtime_id: 'platform:anthropic',
      provider: 'anthropic',
      model: PLATFORM_ANTHROPIC_MODEL,
      source: 'platform_default',
      provider_config_version_id: null,
      credential: env.ANTHROPIC_API_KEY,
    });
  }
  return runtimes;
}

export async function resolveEffectiveRuntimePlan(input: {
  facade: ModelRuntimesFacade;
  env: LiveRuntimeEnv;
  userId: string;
  workspaceId: string;
}): Promise<EffectiveRuntimePlan> {
  const rows = await input.facade.listProviders(input.workspaceId);
  const overrideId = await input.facade.getOverride(input.userId, input.workspaceId);
  const requested = [
    overrideId ? { source: 'user_override' as const, row: rows.find((row) => row.id === overrideId) } : null,
    { source: 'workspace_default' as const, row: rows.find((row) => row.is_default) },
  ].filter((item): item is {
    source: 'user_override' | 'workspace_default';
    row: ProviderConfigRow | undefined;
  } => item !== null);

  const candidates: ResolvedRuntime[] = [];
  const resolutionAttempts: RuntimeResolutionAttempt[] = [];
  const seen = new Set<string>();

  for (const item of requested) {
    if (!item.row) {
      resolutionAttempts.push({
        source: item.source,
        runtime_id: null,
        provider: null,
        outcome: 'skipped',
        code: 'RUNTIME_NOT_FOUND',
      });
      continue;
    }
    if (seen.has(item.row.id)) continue;
    seen.add(item.row.id);
    const resolved = resolveConfiguredRow(item.row, item.source, input.env);
    if (!resolved.runtime) {
      resolutionAttempts.push({
        source: item.source,
        runtime_id: item.row.id,
        provider: item.row.provider,
        outcome: 'skipped',
        code: resolved.code ?? 'RUNTIME_UNAVAILABLE',
      });
      continue;
    }
    candidates.push(resolved.runtime);
  }

  for (const runtime of platformRuntimes(input.env)) {
    if (!candidates.some((candidate) => candidate.runtime_id === runtime.runtime_id)) candidates.push(runtime);
  }
  if (candidates.length === 0) throw new ProviderUnavailableError();

  resolutionAttempts.push(...candidates.map((runtime, index): RuntimeResolutionAttempt => ({
    source: runtime.source,
    runtime_id: runtime.runtime_id,
    provider: runtime.provider,
    outcome: index === 0 ? 'selected' : 'fallback',
    code: null,
  })));
  return { primary: candidates[0], fallbacks: candidates.slice(1), resolution_attempts: resolutionAttempts };
}

function liveFetch(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
}

async function executeRuntime(runtime: ResolvedRuntime, system: string, user: string, maxTokens: number): Promise<{
  text: string;
  usage: { tokens_in: number | null; tokens_out: number | null };
}> {
  if (runtime.provider === 'workers_ai') {
    if (!runtime.ai) throw new Error('WORKERS_AI_BINDING_UNAVAILABLE');
    const out = await runtime.ai.run(runtime.model, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
    }) as Record<string, unknown>;
    const usage = out.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    return {
      text: String(out.response ?? '').trim(),
      usage: { tokens_in: usage?.prompt_tokens ?? null, tokens_out: usage?.completion_tokens ?? null },
    };
  }

  const response = await liveFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': runtime.credential ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: runtime.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!response.ok) throw new Error(`ANTHROPIC_HTTP_${response.status}`);
  const data = await response.json() as Record<string, unknown>;
  const content = Array.isArray(data.content) ? data.content as Array<Record<string, unknown>> : [];
  const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    text: content.filter((part) => part.type === 'text').map((part) => String(part.text ?? '')).join('').trim(),
    usage: { tokens_in: usage?.input_tokens ?? null, tokens_out: usage?.output_tokens ?? null },
  };
}

function errorCode(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase().slice(0, 80) || 'PROVIDER_ERROR';
}

export async function executeEffectiveRuntimePlan(input: {
  plan: EffectiveRuntimePlan;
  system: string;
  user: string;
  maxTokens: number;
  minTextLength?: number;
  observer?: ModelExecutionObserver;
}): Promise<RuntimeExecutionResult> {
  const attempts: RuntimeExecutionAttempt[] = [];
  for (const runtime of [input.plan.primary, ...input.plan.fallbacks]) {
    const startedAt = Date.now();
    const execution = await input.observer?.start({ provider: runtime.provider, model_key: runtime.model });
    try {
      const result = await executeRuntime(runtime, input.system, input.user, input.maxTokens);
      if (result.text.length < (input.minTextLength ?? 40)) throw new Error('SHORT_RESPONSE');
      const latency = Date.now() - startedAt;
      await execution?.complete({
        status: 'completed',
        tokens_in: result.usage.tokens_in,
        tokens_out: result.usage.tokens_out,
        latency_ms: latency,
        error_code: null,
      });
      attempts.push({
        runtime_id: runtime.runtime_id,
        provider: runtime.provider,
        model: runtime.model,
        source: runtime.source,
        status: 'completed',
        error_code: null,
        latency_ms: latency,
        execution_receipt_id: execution?.receipt_id ?? null,
      });
      return {
        text: result.text,
        runtime,
        usage: result.usage,
        latency_ms: latency,
        execution_receipt_id: execution?.receipt_id ?? null,
        attempts,
      };
    } catch (err) {
      const latency = Date.now() - startedAt;
      const code = errorCode(err);
      await execution?.complete({
        status: 'failed', tokens_in: null, tokens_out: null, latency_ms: latency, error_code: code,
      });
      attempts.push({
        runtime_id: runtime.runtime_id,
        provider: runtime.provider,
        model: runtime.model,
        source: runtime.source,
        status: 'failed',
        error_code: code,
        latency_ms: latency,
        execution_receipt_id: execution?.receipt_id ?? null,
      });
    }
  }
  throw new ProviderUnavailableError('all configured live model runtimes failed', attempts);
}
