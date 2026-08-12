import { envFlagTrue } from '../lib/env-flag';

const CAPABILITY_CONTRACT = 'xlooop.external-capability-adapter.v1';
const ADAPTER_TIMEOUT_MS = 20_000;
const MIN_HEADROOM_REDUCTION_PCT = 25;

export interface ExternalCapabilityAdapterEnv {
  EXTERNAL_CAPABILITY_ADAPTER?: Fetcher;
  MARKITDOWN_ADAPTER_ENABLED?: string;
  HEADROOM_COMPRESSION_ENABLED?: string;
  EXTERNAL_CAPABILITY_TENANT_REFS?: string;
}

export interface CapabilityReceipt {
  capability: 'markitdown' | 'headroom';
  tool_version: string;
  source_hash: string;
  output_hash: string;
  latency_ms: number;
  replayable: true;
}

export interface DocumentConversionResult {
  extracted_text: string;
  source_spans: Array<{
    start: number;
    end: number;
    source_ref: string;
    span_kind: 'normalized_output_span';
    provenance_level: 'document';
  }>;
  receipt: CapabilityReceipt;
}

export interface PromptCompressionResult {
  system: string;
  user: string;
  receipt: CapabilityReceipt & {
    tokens_before: number;
    tokens_after: number;
    token_reduction_pct: number;
    transforms_applied: string[];
    redaction_count: number;
    protected_fragment_count: number;
  };
}

export class ExternalCapabilityUnavailableError extends Error {
  readonly code = 'EXTERNAL_CAPABILITY_UNAVAILABLE';
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = 'ExternalCapabilityUnavailableError';
  }
}

function configuredTenantRefs(env: ExternalCapabilityAdapterEnv): Set<string> {
  return new Set((env.EXTERNAL_CAPABILITY_TENANT_REFS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-f0-9]{32}$/.test(value)));
}

async function tenantCapabilityEnabled(
  env: ExternalCapabilityAdapterEnv,
  workspaceId: string,
  flag: string | undefined,
): Promise<boolean> {
  if (!envFlagTrue(flag) || !env.EXTERNAL_CAPABILITY_ADAPTER || !workspaceId) return false;
  return configuredTenantRefs(env).has(await tenantRef(workspaceId));
}

export async function markitdownEnabled(env: ExternalCapabilityAdapterEnv, workspaceId: string): Promise<boolean> {
  return tenantCapabilityEnabled(env, workspaceId, env.MARKITDOWN_ADAPTER_ENABLED);
}

export async function headroomEnabled(env: ExternalCapabilityAdapterEnv, workspaceId: string): Promise<boolean> {
  return tenantCapabilityEnabled(env, workspaceId, env.HEADROOM_COMPRESSION_ENABLED);
}

export async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function tenantRef(workspaceId: string): Promise<string> {
  return (await hashText(`xlooop-tenant:${workspaceId}`)).slice(0, 32);
}

async function callAdapter<T>(
  env: ExternalCapabilityAdapterEnv,
  path: string,
  payload: Record<string, unknown>,
): Promise<T> {
  if (!env.EXTERNAL_CAPABILITY_ADAPTER) {
    throw new ExternalCapabilityUnavailableError('private capability service binding is unavailable');
  }
  let response: Response;
  try {
    response = await env.EXTERNAL_CAPABILITY_ADAPTER.fetch(
      new Request(`https://capability.internal${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-xlooop-capability-contract': CAPABILITY_CONTRACT,
        },
        body: JSON.stringify({ schema_id: CAPABILITY_CONTRACT, ...payload }),
        signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
      }),
    );
  } catch (error) {
    throw new ExternalCapabilityUnavailableError(
      `private capability adapter failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new ExternalCapabilityUnavailableError(`private capability adapter returned HTTP ${response.status}`);
  }
  const body = await response.json().catch(() => null) as T | null;
  if (!body) throw new ExternalCapabilityUnavailableError('private capability adapter returned invalid JSON');
  return body;
}

export async function convertDocumentWithMarkitdown(input: {
  env: ExternalCapabilityAdapterEnv;
  workspace_id: string;
  request_id: string | null;
  filename: string;
  content_type: string;
  content_base64: string;
  source_hash: string;
}): Promise<DocumentConversionResult> {
  if (!await markitdownEnabled(input.env, input.workspace_id)) {
    throw new ExternalCapabilityUnavailableError('MarkItDown adapter is disabled');
  }
  const result = await callAdapter<DocumentConversionResult>(input.env, '/v1/convert/markitdown', {
    tenant_ref: await tenantRef(input.workspace_id),
    request_id: input.request_id,
    filename: input.filename,
    content_type: input.content_type,
    content_base64: input.content_base64,
    source_hash: input.source_hash,
  });
  const outputHash = await hashText(result.extracted_text || '');
  const sourceRef = `sha256:${input.source_hash}`;
  const sourceSpanValid = result.source_spans?.some((span) => (
    span.start === 0 && span.end === result.extracted_text.length && span.source_ref === sourceRef
    && span.span_kind === 'normalized_output_span' && span.provenance_level === 'document'
  ));
  if (!result.extracted_text || result.receipt?.capability !== 'markitdown'
    || result.receipt.source_hash !== input.source_hash || result.receipt.output_hash !== outputHash
    || result.receipt.replayable !== true || !sourceSpanValid) {
    throw new ExternalCapabilityUnavailableError('MarkItDown adapter receipt failed validation');
  }
  return result;
}

function redactForCompression(value: string): { value: string; count: number } {
  let count = 0;
  const replace = (pattern: RegExp, replacement: string) => {
    value = value.replace(pattern, () => { count += 1; return replacement; });
  };
  replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]');
  replace(/\b(?:api[_-]?key|secret|token)\s*[:=]\s*[^\s,;]{8,}/gi, '[REDACTED_SECRET]');
  return { value, count };
}

function protectedPromptFragments(value: string): string[] {
  const fragments = new Set<string>();
  const addMatches = (pattern: RegExp, group = 0) => {
    for (const match of value.matchAll(pattern)) {
      const fragment = match[group]?.trim();
      if (fragment) fragments.add(fragment);
    }
  };
  addMatches(/^Operator question:\s*.+$/gim);
  addMatches(/\b(?:source|citation):[A-Za-z0-9._:/-]+\b/gi);
  addMatches(/\b(?:proj|pkt|event|workspace|tenant|company|user|doc)_[A-Za-z0-9_-]+\b/g);
  addMatches(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)?\b/g);
  addMatches(/"([^"\n]{2,240})"/g, 1);
  return [...fragments];
}

export async function compressPromptWithHeadroom(input: {
  env: ExternalCapabilityAdapterEnv;
  workspace_id: string;
  request_id: string | null;
  system: string;
  user: string;
}): Promise<PromptCompressionResult> {
  if (!await headroomEnabled(input.env, input.workspace_id)) {
    throw new ExternalCapabilityUnavailableError('Headroom adapter is disabled');
  }
  const system = redactForCompression(input.system);
  const user = redactForCompression(input.user);
  const originalHash = await hashText(JSON.stringify([{ role: 'system', content: system.value }, { role: 'user', content: user.value }]));
  const result = await callAdapter<PromptCompressionResult>(input.env, '/v1/compress/headroom', {
    tenant_ref: await tenantRef(input.workspace_id),
    request_id: input.request_id,
    messages: [{ role: 'system', content: system.value }, { role: 'user', content: user.value }],
    source_hash: originalHash,
    redaction_count: system.count + user.count,
  });
  const outputHash = await hashText(JSON.stringify([
    { role: 'system', content: result.system },
    { role: 'user', content: result.user },
  ]));
  const protectedFragments = protectedPromptFragments(user.value);
  const protectedFragmentsPreserved = protectedFragments.every((fragment) => result.user.includes(fragment));
  if (!result.system || !result.user || result.receipt?.capability !== 'headroom'
    || result.receipt.source_hash !== originalHash || result.receipt.output_hash !== outputHash
    || result.receipt.replayable !== true
    || result.system !== system.value || !protectedFragmentsPreserved
    || !Number.isFinite(result.receipt.tokens_before) || !Number.isFinite(result.receipt.tokens_after)
    || result.receipt.tokens_before <= 0 || result.receipt.tokens_after >= result.receipt.tokens_before
    || result.receipt.token_reduction_pct < MIN_HEADROOM_REDUCTION_PCT) {
    throw new ExternalCapabilityUnavailableError('Headroom adapter receipt failed validation');
  }
  return {
    ...result,
    receipt: { ...result.receipt, protected_fragment_count: protectedFragments.length },
  };
}

export const externalCapabilityContractId = CAPABILITY_CONTRACT;
