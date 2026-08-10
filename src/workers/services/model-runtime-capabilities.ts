import type { ModelRuntimeProvider } from '../dal/model-runtime-store';
import { CLOUD_EXECUTABLE_PROVIDERS } from './model-runtime-provider-adapters';

export const PLATFORM_WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const PLATFORM_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

const RELAY_REQUIRED_PROVIDERS = ['ollama', 'lm_studio', 'vllm', 'llama_cpp', 'custom'] as const;
const DEFAULT_MODELS: Partial<Record<ModelRuntimeProvider | 'workers_ai', string>> = {
  workers_ai: PLATFORM_WORKERS_AI_MODEL,
  anthropic: PLATFORM_ANTHROPIC_MODEL,
  openai: 'gpt-4o-mini',
  google: 'gemini-3.5-flash',
  mistral: 'mistral-small-latest',
  deepseek: 'deepseek-v4-flash',
  openrouter: 'openai/gpt-4o-mini',
};

export function commercialLiveChatRequired(raw: string | undefined): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  return !['false', 'off', '0', 'no', 'disabled'].includes(value);
}

export function isExecutableRuntimeProvider(provider: ModelRuntimeProvider | 'workers_ai'): boolean {
  return provider === 'workers_ai' || (CLOUD_EXECUTABLE_PROVIDERS as readonly string[]).includes(provider);
}

export function runtimeProviderCapability(
  provider: ModelRuntimeProvider | 'workers_ai',
): 'EXECUTABLE' | 'RELAY_REQUIRED' | 'ADAPTER_UNAVAILABLE' {
  if (isExecutableRuntimeProvider(provider)) return 'EXECUTABLE';
  if ((RELAY_REQUIRED_PROVIDERS as readonly string[]).includes(provider)) return 'RELAY_REQUIRED';
  return 'ADAPTER_UNAVAILABLE';
}

export function defaultModelFor(provider: ModelRuntimeProvider | 'workers_ai'): string {
  return DEFAULT_MODELS[provider] ?? '';
}

export function supportedModels(
  provider: ModelRuntimeProvider | 'workers_ai',
  configuredModel?: string | null,
): string[] {
  const models = [configuredModel, defaultModelFor(provider)].filter((value): value is string => Boolean(value));
  return [...new Set(models)];
}
