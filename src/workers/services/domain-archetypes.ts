// domain-archetypes.ts — ABS-P3 · customer-provisioning domain-skeleton registry (v0, PURE).
//
// WHY. A fresh tenant provisions today with ONE bare project (customer-provisioning-store.ts). To reach
// MB-P-SHAPED operation, a new account needs a DOMAIN SKELETON — the set of life/operating domains a
// customer organizes work under (MB-P's counterpart: the 7-file _ops domain set). This module is the
// Tier-B TEMPLATE: a small registry of ARCHETYPES, each a list of structural domain skeletons that the
// flag-gated provisioning scaffold (onboarding-provisioner.ts, DOMAIN_SCAFFOLD_ENABLED) instantiates as
// HONEST-EMPTY synthetic_domains for the new workspace.
//
// HONEST-EMPTY CONTRACT (enforced by scripts/verify-domain-scaffold-honest-empty.mjs): a skeleton carries
// ONLY structural identity — slug / label / kind. It NEVER carries goals, metrics, roadmaps,
// recommendations, counts, or timestamps. The scaffolded domain is structurally present but empty; the
// customer (or a governed agent) fills it. No fabricated content, ever.
//
// GENERIC, NOT MB-P-PRIVATE: these archetypes are platform-canonical Tier-B templates (they belong to no
// account). They are genericized shapes any customer could adopt — NOT MB-P's private domain values.

import type { SyntheticDomainCreateInput, SyntheticDomainKind } from '../dal/types/synthetic-domain';

/** A structural domain slot — identity only, no content. */
export interface DomainSkeleton {
  slug: string;
  label: string;
  kind: SyntheticDomainKind;
}

/** A named set of domain skeletons a new tenant can be scaffolded with. */
export interface DomainArchetype {
  key: string;
  label: string;
  description: string;
  domains: DomainSkeleton[];
}

/** Platform-canonical seed archetypes. STRUCTURE ONLY. Extend by adding a key here (a customer-authoring
 *  path is a later phase). */
export const DOMAIN_ARCHETYPES: Record<string, DomainArchetype> = {
  // A company/SMB operating shape — the domains an owner-operated business organizes work under.
  'regulated-smb': {
    key: 'regulated-smb',
    label: 'Regulated SMB',
    description: 'Operating domains for an owner-operated regulated small business.',
    domains: [
      { slug: 'operations', label: 'Operations', kind: 'company' },
      { slug: 'compliance', label: 'Compliance', kind: 'company' },
      { slug: 'finance', label: 'Finance', kind: 'company' },
      { slug: 'sales-and-marketing', label: 'Sales & Marketing', kind: 'company' },
      { slug: 'people', label: 'People', kind: 'company' },
      { slug: 'clients', label: 'Clients', kind: 'company' },
    ],
  },
  // A personal operating shape — the life domains an individual operator organizes around.
  'personal-operating-system': {
    key: 'personal-operating-system',
    label: 'Personal Operating System',
    description: 'Life domains for an individual operator running their own operating system.',
    domains: [
      { slug: 'career', label: 'Career', kind: 'life' },
      { slug: 'health', label: 'Health', kind: 'life' },
      { slug: 'finances', label: 'Finances', kind: 'life' },
      { slug: 'learning', label: 'Learning', kind: 'life' },
      { slug: 'relationships', label: 'Relationships', kind: 'life' },
      { slug: 'projects', label: 'Projects', kind: 'life' },
    ],
  },
};

/** Default archetype key selected from the onboarding account type. 'personal' → the life archetype,
 *  everything else (company/both/unknown) → the SMB archetype. Pure + total. */
export function archetypeKeyForAccountType(accountType: string | null | undefined): string {
  return String(accountType || '').toLowerCase() === 'personal'
    ? 'personal-operating-system'
    : 'regulated-smb';
}

/** Resolve an archetype by key, or null if unknown (caller treats null as "scaffold nothing"). */
export function resolveArchetype(key: string | null | undefined): DomainArchetype | null {
  if (!key) return null;
  return DOMAIN_ARCHETYPES[key] ?? null;
}

/** Map a skeleton → a valid HONEST-EMPTY SyntheticDomainCreateInput scoped to the new workspace. The
 *  binding is the minimal structurally-valid rule (≥1 filter, required by validateSyntheticBindingThrowing):
 *  a workspace_id_in filter scoped to this workspace. Provenance is stamped in metadata; NO goals/metrics. */
export function skeletonToCreateInput(
  skeleton: DomainSkeleton,
  workspaceId: string,
  ownerUserId: string,
  archetypeKey: string,
): SyntheticDomainCreateInput {
  return {
    workspace_id: workspaceId,
    slug: skeleton.slug,
    label: skeleton.label,
    kind: skeleton.kind,
    owner_user_id: ownerUserId,
    visibility: 'workspace',
    binding: {
      version: 1,
      combine: 'any',
      filters: [{ type: 'workspace_id_in', values: [workspaceId] }],
    },
    metadata: { scaffolded_by: 'domain-archetype-scaffold', archetype: archetypeKey },
  };
}
