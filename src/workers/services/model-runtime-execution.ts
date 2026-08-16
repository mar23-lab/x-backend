import type { ModelRuntimesFacade } from '../dal/model-runtime-facade';
import type { ModelRuntimeProvider, ProviderConfigRow } from '../dal/model-runtime-store';
import type { ModelExecutionObserver } from '../lib/model-execution-lineage';
import { decryptCredential, modelRuntimeEncryptionConfig } from '../lib/model-runtime-crypto';
import type { AiRunner } from './agent-digest';
import {
  defaultModelFor,
  PLATFORM_ANTHROPIC_MODEL,
  PLATFORM_WORKERS_AI_MODEL,
  runtimeProviderCapability,
  supportedModels,
} from './model-runtime-capabilities';
import {
  CLOUD_EXECUTABLE_PROVIDERS,
  discoverCloudRuntimeModels,
  executeCloudRuntime,
  type CloudAdapterRuntime,
  type CloudRuntimeProvider,
} from './model-runtime-provider-adapters';
import { normalizeWorkersAiText } from './workers-ai-response';

export {
  commercialLiveChatRequired,
  isExecutableRuntimeProvider,
  PLATFORM_WORKERS_AI_MODEL,
  runtimeProviderCapability,
  supportedModels,
} from './model-runtime-capabilities';

export type LiveRuntimeProvider = 'workers_ai' | CloudRuntimeProvider;
export type RuntimeResolutionSource = 'request_preference' | 'user_override' | 'workspace_default' | 'platform_default';

interface RuntimeCredential { api_key: string; deployment?: string }

export interface LiveRuntimeEnv {
  AI?: AiRunner;
  ANTHROPIC_API_KEY?: string;
  MODEL_RUNTIME_ENC_KEY?: string;
  MODEL_RUNTIME_ENC_KEYS?: string;
  MODEL_RUNTIME_ACTIVE_KEY_ID?: string;
}

export interface ResolvedRuntime {
  runtime_id: string;
  provider: LiveRuntimeProvider;
  model: string;
  source: RuntimeResolutionSource;
  provider_config_version_id: string | null;
  base_url: string | null;
  credential: RuntimeCredential | null;
  ai?: AiRunner;
}

export type RuntimeDescriptor = Omit<ResolvedRuntime, 'credential' | 'ai'>;
export interface RuntimeResolutionAttempt {
  source: RuntimeResolutionSource;
  runtime_id: string | null;
  provider: string | null;
  outcome: 'selected' | 'fallback' | 'skipped';
  code: string | null;
}

export interface EffectiveRuntimePlan { primary: ResolvedRuntime; fallbacks: ResolvedRuntime[]; resolution_attempts: RuntimeResolutionAttempt[] }
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
  runtime: RuntimeDescriptor;
  usage: { tokens_in: number | null; tokens_out: number | null };
  latency_ms: number;
  execution_receipt_id: string | null;
  attempts: RuntimeExecutionAttempt[];
}

export type ValidationRepairInput = { text: string; error_code: string; system: string; user: string; repair_attempt: number };
export type ValidationRepairPrompt = { system: string; user: string };

export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  readonly status = 503;
  readonly attempts: RuntimeExecutionAttempt[];
  readonly resolution_attempts: RuntimeResolutionAttempt[];

  constructor(
    message = 'no live model runtime is available',
    attempts: RuntimeExecutionAttempt[] = [],
    resolutionAttempts: RuntimeResolutionAttempt[] = [],
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.attempts = attempts;
    this.resolution_attempts = resolutionAttempts;
  }
}

export class RuntimeCapabilityError extends Error {
  readonly status = 503;
  readonly code: 'RELAY_REQUIRED' | 'ADAPTER_UNAVAILABLE';

  constructor(code: 'RELAY_REQUIRED' | 'ADAPTER_UNAVAILABLE') {
    super(code === 'RELAY_REQUIRED'
      ? 'an authenticated customer-side outbound relay is required for this runtime'
      : 'no approved server-side adapter is available for this runtime');
    this.name = 'RuntimeCapabilityError';
    this.code = code;
  }
}

export class RuntimePreferenceError extends Error {
  readonly status = 422;
  readonly code: 'RUNTIME_PREFERENCE_INVALID' | 'MODEL_NOT_AVAILABLE';

  constructor(code: 'RUNTIME_PREFERENCE_INVALID' | 'MODEL_NOT_AVAILABLE', message: string) {
    super(message);
    this.name = 'RuntimePreferenceError';
    this.code = code;
  }
}

function isCloudRuntimeProvider(provider: ModelRuntimeProvider): provider is CloudRuntimeProvider {
  return (CLOUD_EXECUTABLE_PROVIDERS as readonly string[]).includes(provider);
}

function providerConfigVersion(row: ProviderConfigRow): string {
  return `model-runtime-provider:${row.id}:${row.updated_at}`;
}

function parseStoredCredential(plaintext: string): RuntimeCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  const apiKey = typeof value.api_key === 'string' ? value.api_key.trim() : '';
  if (!apiKey) return null;
  const deployment = typeof value.deployment === 'string' ? value.deployment.trim() : '';
  return { api_key: apiKey, ...(deployment ? { deployment } : {}) };
}

async function resolveConfiguredRow(
  row: ProviderConfigRow,
  source: Exclude<RuntimeResolutionSource, 'platform_default'>,
  facade: ModelRuntimesFacade,
  workspaceId: string,
  env: LiveRuntimeEnv,
): Promise<{ runtime?: ResolvedRuntime; code?: string }> {
  if (!row.enabled) return { code: 'RUNTIME_DISABLED' };
  const capability = runtimeProviderCapability(row.provider);
  if (capability !== 'EXECUTABLE') return { code: capability };
  if (!isCloudRuntimeProvider(row.provider)) return { code: 'ADAPTER_UNAVAILABLE' };
  const sealed = await facade.getProviderCredential(workspaceId, row.provider);
  if (!sealed?.ciphertext || !sealed.iv) return { code: 'STORED_CREDENTIAL_UNAVAILABLE' };
  let credential: RuntimeCredential | null = null;
  try {
    credential = parseStoredCredential(await decryptCredential(modelRuntimeEncryptionConfig(env), {
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
    }, { tenant_id: workspaceId, purpose: row.provider }));
  } catch {
    return { code: 'CREDENTIAL_DECRYPTION_FAILED' };
  }
  if (!credential) return { code: 'CREDENTIAL_FORMAT_INVALID' };
  if (row.provider === 'azure_openai' && !(credential.deployment || row.model?.trim())) {
    return { code: 'AZURE_DEPLOYMENT_REQUIRED' };
  }
  return {
    runtime: {
      runtime_id: row.id,
      provider: row.provider,
      model: row.model?.trim() || defaultModelFor(row.provider),
      source,
      provider_config_version_id: providerConfigVersion(row),
      base_url: row.base_url,
      credential,
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
      base_url: null,
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
      base_url: null,
      credential: { api_key: env.ANTHROPIC_API_KEY },
    });
  }
  return runtimes;
}

export function resolvePlatformRuntimePlan(env: LiveRuntimeEnv): EffectiveRuntimePlan {
  const candidates = platformRuntimes(env);
  if (!candidates.length) throw new ProviderUnavailableError();
  return {
    primary: candidates[0],
    fallbacks: candidates.slice(1),
    resolution_attempts: candidates.map((runtime, index) => ({
      source: runtime.source,
      runtime_id: runtime.runtime_id,
      provider: runtime.provider,
      outcome: index === 0 ? 'selected' : 'fallback',
      code: null,
    })),
  };
}

export async function resolveEffectiveRuntimePlan(input: {
  facade: ModelRuntimesFacade;
  env: LiveRuntimeEnv;
  userId: string;
  workspaceId: string;
  runtimeId?: string | null;
  modelId?: string | null;
}): Promise<EffectiveRuntimePlan> {
  // A platform-managed live runtime remains a valid commercial fallback when
  // tenant runtime storage is unavailable (for example during bootstrap or a
  // bounded degraded read). Never turn that condition into a raw 500 and never
  // fall back to deterministic assistant prose.
  if (!input.facade || typeof input.facade.listProviders !== 'function') {
    return resolvePlatformRuntimePlan(input.env);
  }
  const rows = await input.facade.listProviders(input.workspaceId);
  const runtimeId = String(input.runtimeId ?? '').trim() || null;
  const modelId = String(input.modelId ?? '').trim() || null;
  if (modelId && !runtimeId) {
    throw new RuntimePreferenceError(
      'RUNTIME_PREFERENCE_INVALID',
      'model_id requires a tenant-scoped runtime_id',
    );
  }
  const platformCandidates = platformRuntimes(input.env);
  const preferredRow = runtimeId ? rows.find((row) => row.id === runtimeId) : undefined;
  const preferredPlatform = runtimeId ? platformCandidates.find((runtime) => runtime.runtime_id === runtimeId) : undefined;
  if (runtimeId && !preferredRow && !preferredPlatform) {
    throw new RuntimePreferenceError(
      'RUNTIME_PREFERENCE_INVALID',
      'runtime_id is not configured for this workspace',
    );
  }
  const overrideId = await input.facade.getOverride(input.userId, input.workspaceId);
  const requested: Array<{
    source: 'request_preference' | 'user_override' | 'workspace_default';
    row: ProviderConfigRow | undefined;
  }> = [];
  if (preferredRow) requested.push({ source: 'request_preference', row: preferredRow });
  if (overrideId) requested.push({ source: 'user_override', row: rows.find((row) => row.id === overrideId) });
  requested.push({ source: 'workspace_default', row: rows.find((row) => row.is_default) });

  const candidates: ResolvedRuntime[] = [];
  const resolutionAttempts: RuntimeResolutionAttempt[] = [];
  const seen = new Set<string>();
  if (preferredPlatform) {
    if (modelId && !supportedModels(preferredPlatform.provider, preferredPlatform.model).includes(modelId)) {
      throw new RuntimePreferenceError('MODEL_NOT_AVAILABLE', 'model_id is not available from the selected platform runtime');
    }
    candidates.push({
      ...preferredPlatform, source: 'request_preference', ...(modelId ? { model: modelId } : {}),
    });
    seen.add(preferredPlatform.runtime_id);
  }
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
    const resolved = await resolveConfiguredRow(
      item.row,
      item.source,
      input.facade,
      input.workspaceId,
      input.env,
    );
    if (!resolved.runtime) {
      if (item.source === 'request_preference'
        && (resolved.code === 'RELAY_REQUIRED' || resolved.code === 'ADAPTER_UNAVAILABLE')) {
        throw new RuntimeCapabilityError(resolved.code);
      }
      resolutionAttempts.push({
        source: item.source,
        runtime_id: item.row.id,
        provider: item.row.provider,
        outcome: 'skipped',
        code: resolved.code ?? 'RUNTIME_UNAVAILABLE',
      });
      continue;
    }
    if (item.source === 'request_preference' && modelId) {
      if (modelId !== resolved.runtime.model) {
        let available: string[];
        try {
          available = await discoverCloudRuntimeModels(resolved.runtime as CloudAdapterRuntime);
        } catch {
          throw new ProviderUnavailableError(
            'the requested runtime model inventory could not be verified',
            [],
            resolutionAttempts,
          );
        }
        if (!available.includes(modelId)) {
          throw new RuntimePreferenceError(
            'MODEL_NOT_AVAILABLE',
            'model_id is not available from the selected tenant runtime',
          );
        }
      }
      resolved.runtime.model = modelId;
    }
    candidates.push(resolved.runtime);
  }

  for (const runtime of platformCandidates) {
    if (!candidates.some((candidate) => candidate.runtime_id === runtime.runtime_id)) candidates.push(runtime);
  }
  if (candidates.length === 0) {
    throw new ProviderUnavailableError('no live model runtime is available', [], resolutionAttempts);
  }

  resolutionAttempts.push(...candidates.map((runtime, index): RuntimeResolutionAttempt => ({
    source: runtime.source,
    runtime_id: runtime.runtime_id,
    provider: runtime.provider,
    outcome: index === 0 ? 'selected' : 'fallback',
    code: null,
  })));
  return { primary: candidates[0], fallbacks: candidates.slice(1), resolution_attempts: resolutionAttempts };
}

export async function resolveConfiguredRuntime(input: {
  facade: ModelRuntimesFacade;
  env: LiveRuntimeEnv;
  workspaceId: string;
  provider: ModelRuntimeProvider;
}): Promise<ResolvedRuntime> {
  const row = (await input.facade.listProviders(input.workspaceId))
    .find((candidate) => candidate.provider === input.provider);
  if (!row) throw new ProviderUnavailableError('provider is not configured');
  const resolved = await resolveConfiguredRow(
    row,
    'workspace_default',
    input.facade,
    input.workspaceId,
    input.env,
  );
  if (!resolved.runtime) {
    if (resolved.code === 'RELAY_REQUIRED' || resolved.code === 'ADAPTER_UNAVAILABLE') {
      throw new RuntimeCapabilityError(resolved.code);
    }
    throw new ProviderUnavailableError(`provider is unavailable: ${resolved.code ?? 'RUNTIME_UNAVAILABLE'}`);
  }
  return resolved.runtime;
}

async function executeRuntime(runtime: ResolvedRuntime, system: string, user: string, maxTokens: number): Promise<{
  text: string;
  usage: { tokens_in: number | null; tokens_out: number | null };
}> {
  if (runtime.provider === 'workers_ai') {
    if (!runtime.ai) throw new Error('WORKERS_AI_BINDING_UNAVAILABLE');
    const out = await runtime.ai.run(runtime.model, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_completion_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }) as Record<string, unknown>;
    // Current chat-completions models (including GLM-4.7) return OpenAI-style
    // choices, while older Workers AI text-generation models return response.
    return normalizeWorkersAiText(out);
  }

  if (!runtime.credential?.api_key) throw new Error('STORED_CREDENTIAL_UNAVAILABLE');
  return executeCloudRuntime(runtime as CloudAdapterRuntime, system, user, maxTokens);
}

export async function discoverRuntimeModels(runtime: ResolvedRuntime): Promise<string[]> {
  if (runtime.provider === 'workers_ai') return supportedModels('workers_ai', runtime.model);
  if (!runtime.credential?.api_key) throw new Error('STORED_CREDENTIAL_UNAVAILABLE');
  const discovered = await discoverCloudRuntimeModels(runtime as CloudAdapterRuntime);
  return [...new Set([...supportedModels(runtime.provider, runtime.model), ...discovered])].slice(0, 200);
}

function publicRuntime(runtime: ResolvedRuntime): RuntimeDescriptor {
  const { credential: _credential, ai: _ai, ...descriptor } = runtime;
  return descriptor;
}

function errorCode(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase().slice(0, 80) || 'PROVIDER_ERROR';
}

function runtimeAttempt(runtime: ResolvedRuntime, status: RuntimeExecutionAttempt['status'], error_code: string | null,
  latency_ms: number, execution_receipt_id: string | null): RuntimeExecutionAttempt {
  return { runtime_id: runtime.runtime_id, provider: runtime.provider, model: runtime.model, source: runtime.source,
    status, error_code, latency_ms, execution_receipt_id };
}

export async function executeEffectiveRuntimePlan(input: {
  plan: EffectiveRuntimePlan;
  system: string;
  user: string;
  maxTokens: number;
  minTextLength?: number;
  validateText?: (text: string) => string | null;
  maxValidationRepairs?: number;
  buildValidationRepair?: (input: ValidationRepairInput) => ValidationRepairPrompt | null;
  observer?: ModelExecutionObserver;
}): Promise<RuntimeExecutionResult> {
  const attempts: RuntimeExecutionAttempt[] = [];
  const maxValidationRepairs = Math.max(0, Math.min(2, input.maxValidationRepairs ?? 0));
  for (const runtime of [input.plan.primary, ...input.plan.fallbacks]) {
    let executionSystem = input.system;
    let executionUser = input.user;
    for (let repairAttempt = 0; repairAttempt <= maxValidationRepairs; repairAttempt += 1) {
      const startedAt = Date.now();
      const execution = await input.observer?.start({ provider: runtime.provider, model_key: runtime.model });
      let result: Awaited<ReturnType<typeof executeRuntime>> | null = null;
      let validationError: string | null = null;
      try {
        result = await executeRuntime(runtime, executionSystem, executionUser, input.maxTokens);
        if (result.text.length < (input.minTextLength ?? 1)) throw new Error('EMPTY_RESPONSE');
        validationError = input.validateText?.(result.text) ?? null;
        if (validationError) throw new Error(validationError);
        const latency = Date.now() - startedAt;
        await execution?.complete({
          status: 'completed', tokens_in: result.usage.tokens_in, tokens_out: result.usage.tokens_out,
          latency_ms: latency, error_code: null,
        });
        attempts.push(runtimeAttempt(runtime, 'completed', null, latency, execution?.receipt_id ?? null));
        return {
          text: result.text, runtime: publicRuntime(runtime), usage: result.usage,
          latency_ms: latency, execution_receipt_id: execution?.receipt_id ?? null, attempts,
        };
      } catch (err) {
        const latency = Date.now() - startedAt;
        const code = errorCode(err);
        await execution?.complete({
          status: 'failed', tokens_in: result?.usage.tokens_in ?? null, tokens_out: result?.usage.tokens_out ?? null,
          latency_ms: latency, error_code: code,
        });
        attempts.push(runtimeAttempt(runtime, 'failed', code, latency, execution?.receipt_id ?? null));
        if (!validationError || !result || repairAttempt >= maxValidationRepairs || !input.buildValidationRepair) break;
        const repair = input.buildValidationRepair({ text: result.text, error_code: code,
          system: input.system, user: input.user, repair_attempt: repairAttempt + 1 });
        if (!repair) break;
        executionSystem = repair.system;
        executionUser = repair.user;
      }
    }
  }
  throw new ProviderUnavailableError('all configured live model runtimes failed', attempts);
}

export async function validateRuntime(runtime: ResolvedRuntime, observer?: ModelExecutionObserver): Promise<RuntimeExecutionResult> {
  return executeEffectiveRuntimePlan({
    plan: { primary: runtime, fallbacks: [], resolution_attempts: [] },
    system: 'You are validating a model-runtime connection. Follow the user instruction exactly.',
    user: 'Reply with exactly: Xlooop runtime ready. This is a connection test and contains no customer data.',
    maxTokens: 32,
    minTextLength: 1,
    observer,
  });
}
