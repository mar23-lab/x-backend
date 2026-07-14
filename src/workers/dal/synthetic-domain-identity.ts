// synthetic-domain-identity.ts · stable IDs + derivation fingerprints

import type {
  DomainId,
  SyntheticDerivativeMutationKind,
  SyntheticDomainBinding,
  WorkspaceId,
} from './types';

export const DEFAULT_SYNTHETIC_DERIVATIVE_MUTATIONS: SyntheticDerivativeMutationKind[] = [
  'recommendation',
  'roadmap',
  'roadmap_item',
  'goal',
  'todo',
  'membership_binding',
  'progress_observation',
  'propagation_rule',
];

export interface SyntheticDerivationFingerprintInput {
  source_domains: DomainId[];
  binding: SyntheticDomainBinding;
  purpose_key: string;
  algorithm_version?: string;
}

export function normalizeSyntheticSourceDomains(
  explicit: readonly string[] | undefined,
  binding: SyntheticDomainBinding,
  workspaceId: WorkspaceId | null,
  slug: string,
): DomainId[] {
  const fromExplicit = Array.isArray(explicit) ? explicit : [];
  const fromBinding = binding.filters
    .filter((filter) => filter.type === 'domain_id_in')
    .flatMap((filter) => filter.values);
  const fallbackWorkspace = sanitizeDomainPart(workspaceId || 'cross-workspace');
  const fallbackSlug = sanitizeDomainPart(slug);
  const fallback = `domain:${fallbackWorkspace}:${fallbackSlug}`;
  return stableUniqueSorted([...fromExplicit, ...fromBinding].filter(Boolean).length ? [...fromExplicit, ...fromBinding] : [fallback]);
}

export async function computeSyntheticDerivationFingerprint(
  input: SyntheticDerivationFingerprintInput,
): Promise<string> {
  const canonical = canonicalJson({
    algorithm_version: input.algorithm_version || 'lem-v4',
    binding: normalizeBinding(input.binding),
    purpose_key: input.purpose_key,
    source_domains: stableUniqueSorted(input.source_domains),
  });
  const digest = await sha256Hex(canonical);
  return `sdsrc:sha256:${digest}`;
}

function normalizeBinding(binding: SyntheticDomainBinding): SyntheticDomainBinding {
  return {
    version: 1,
    combine: binding.combine,
    filters: [...binding.filters]
      .map((filter) => ({
        type: filter.type,
        values: stableUniqueSorted(filter.values),
      }))
      .sort((a, b) => `${a.type}:${a.values.join('|')}`.localeCompare(`${b.type}:${b.values.join('|')}`)),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableUniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function sanitizeDomainPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

async function sha256Hex(input: string): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error('computeSyntheticDerivationFingerprint requires WebCrypto SHA-256 support');
  }
  const bytes = new TextEncoder().encode(input);
  const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
