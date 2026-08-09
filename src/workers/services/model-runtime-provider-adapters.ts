// Fixed, server-side cloud provider adapters. Tenant-controlled URLs never enter this module except
// Azure endpoints, which pass the strict Microsoft host allowlist below.

export const CLOUD_EXECUTABLE_PROVIDERS = [
  'anthropic', 'openai', 'google', 'mistral', 'deepseek', 'openrouter', 'azure_openai',
] as const;

export type CloudRuntimeProvider = (typeof CLOUD_EXECUTABLE_PROVIDERS)[number];

export interface CloudAdapterRuntime {
  provider: CloudRuntimeProvider;
  model: string;
  base_url: string | null;
  credential: { api_key: string; deployment?: string };
}

export interface ProviderTextResult {
  text: string;
  usage: { tokens_in: number | null; tokens_out: number | null };
}

const PROVIDER_TIMEOUT_MS = 30_000;

function liveFetch(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
}

function safeAzureEndpoint(raw: string | null): string {
  if (!raw) throw new Error('AZURE_ENDPOINT_REQUIRED');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('AZURE_ENDPOINT_NOT_ALLOWED');
  }
  const allowedHost = url.hostname.endsWith('.openai.azure.com')
    || url.hostname.endsWith('.services.ai.azure.com');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (
    url.protocol !== 'https:'
    || !allowedHost
    || Boolean(url.username || url.password || url.port || url.search || url.hash)
    || !['/', '/openai/v1'].includes(path)
  ) throw new Error('AZURE_ENDPOINT_NOT_ALLOWED');
  return url.origin;
}

function openAiBaseUrl(runtime: CloudAdapterRuntime): string {
  switch (runtime.provider) {
    case 'openai': return 'https://api.openai.com/v1';
    case 'mistral': return 'https://api.mistral.ai/v1';
    case 'deepseek': return 'https://api.deepseek.com';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'azure_openai': return `${safeAzureEndpoint(runtime.base_url)}/openai/v1`;
    default: throw new Error('PROVIDER_ADAPTER_UNAVAILABLE');
  }
}

function openAiText(data: Record<string, unknown>): string {
  const choices = Array.isArray(data.choices) ? data.choices as Array<Record<string, unknown>> : [];
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('')
    .trim();
}

async function executeOpenAiCompatible(
  runtime: CloudAdapterRuntime,
  system: string,
  user: string,
  maxTokens: number,
): Promise<ProviderTextResult> {
  const azure = runtime.provider === 'azure_openai';
  const response = await liveFetch(`${openAiBaseUrl(runtime)}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(azure
        ? { 'api-key': runtime.credential.api_key }
        : { authorization: `Bearer ${runtime.credential.api_key}` }),
    },
    body: JSON.stringify({
      model: azure ? runtime.credential.deployment || runtime.model : runtime.model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!response.ok) throw new Error(`${runtime.provider.toUpperCase()}_HTTP_${response.status}`);
  const data = await response.json() as Record<string, unknown>;
  const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return {
    text: openAiText(data),
    usage: { tokens_in: usage?.prompt_tokens ?? null, tokens_out: usage?.completion_tokens ?? null },
  };
}

async function executeAnthropic(
  runtime: CloudAdapterRuntime,
  system: string,
  user: string,
  maxTokens: number,
): Promise<ProviderTextResult> {
  const response = await liveFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': runtime.credential.api_key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: runtime.model, max_tokens: maxTokens, system,
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

async function executeGoogle(
  runtime: CloudAdapterRuntime,
  system: string,
  user: string,
  maxTokens: number,
): Promise<ProviderTextResult> {
  const model = runtime.model.replace(/^models\//, '');
  const response = await liveFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': runtime.credential.api_key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    },
  );
  if (!response.ok) throw new Error(`GOOGLE_HTTP_${response.status}`);
  const data = await response.json() as Record<string, unknown>;
  const candidates = Array.isArray(data.candidates) ? data.candidates as Array<Record<string, unknown>> : [];
  const content = candidates[0]?.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.parts) ? content.parts as Array<Record<string, unknown>> : [];
  const usage = data.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
  return {
    text: parts.map((part) => String(part.text ?? '')).join('').trim(),
    usage: { tokens_in: usage?.promptTokenCount ?? null, tokens_out: usage?.candidatesTokenCount ?? null },
  };
}

export function executeCloudRuntime(
  runtime: CloudAdapterRuntime,
  system: string,
  user: string,
  maxTokens: number,
): Promise<ProviderTextResult> {
  if (runtime.provider === 'anthropic') return executeAnthropic(runtime, system, user, maxTokens);
  if (runtime.provider === 'google') return executeGoogle(runtime, system, user, maxTokens);
  return executeOpenAiCompatible(runtime, system, user, maxTokens);
}

function discoveredModelIds(data: Record<string, unknown>, provider: CloudRuntimeProvider): string[] {
  if (provider === 'google') {
    const models = Array.isArray(data.models) ? data.models as Array<Record<string, unknown>> : [];
    return models
      .filter((model) => !Array.isArray(model.supportedGenerationMethods)
        || (model.supportedGenerationMethods as unknown[]).includes('generateContent'))
      .map((model) => String(model.name ?? '').replace(/^models\//, '').trim())
      .filter(Boolean);
  }
  const models = Array.isArray(data.data) ? data.data as Array<Record<string, unknown>> : [];
  return models.map((model) => String(model.id ?? '').trim()).filter(Boolean);
}

export async function discoverCloudRuntimeModels(runtime: CloudAdapterRuntime): Promise<string[]> {
  let url: string;
  let headers: Record<string, string>;
  if (runtime.provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/models';
    headers = { 'x-api-key': runtime.credential.api_key, 'anthropic-version': '2023-06-01' };
  } else if (runtime.provider === 'google') {
    url = 'https://generativelanguage.googleapis.com/v1beta/models';
    headers = { 'x-goog-api-key': runtime.credential.api_key };
  } else {
    url = `${openAiBaseUrl(runtime)}/models`;
    headers = runtime.provider === 'azure_openai'
      ? { 'api-key': runtime.credential.api_key }
      : { authorization: `Bearer ${runtime.credential.api_key}` };
  }
  const response = await liveFetch(url, { method: 'GET', headers });
  if (!response.ok) throw new Error(`${runtime.provider.toUpperCase()}_MODELS_HTTP_${response.status}`);
  return discoveredModelIds(await response.json() as Record<string, unknown>, runtime.provider);
}
