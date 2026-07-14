// types/synthetic-domain.ts · Synthetic domains — LEM-v3 PR-1 (DAL split from types.ts)

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { DomainId, ProjectId, UserId, WorkspaceId } from './identity';

// ============================================================
// R49' · Synthetic Domains (LEM-v3 PR-1)
// ============================================================
//
// Authority: docs/_archive/audits/260528-r49-lem-v3-plan/LEM_V3_ARCHITECTURE.md
//
// Synthetic domains are first-class derived membership entities. Each
// synthetic domain owns a binding (filter rule set) that selects member
// projects from its workspace (or cross-workspace when workspace_id is NULL).
//
// Forward-compat columns (has_roadmap, goal_count, open_recommendation_count)
// are present from PR-1 so LEM-v3 PR-3+ doesn't need a backfill migration.

export type SyntheticDomainId = string;            // 'sd_<nanoid>'

export type SyntheticDomainVisibility = 'operator_only' | 'workspace' | 'public_safe';
export type SyntheticDomainEditRole   = 'owner' | 'operator' | 'member';
export type SyntheticDomainStatus     = 'active' | 'paused' | 'archived';
export type SyntheticDerivativeMutationKind =
  | 'recommendation'
  | 'roadmap'
  | 'roadmap_item'
  | 'goal'
  | 'todo'
  | 'membership_binding'
  | 'progress_observation'
  | 'propagation_rule';

export type SyntheticDomainFilterType =
  | 'workspace_id_in'
  | 'domain_id_in'
  | 'parent_project_id_in'
  | 'status_in'
  | 'tag_in'
  | 'metadata_path'   // values like 'vertical=software_dev' · key=value pairs
  | 'source_kind_in'  // R1: match projects whose connected source kind ∈ values (github_repo|desktop_folder|...)
  | 'source_ref_path'; // R1: match SOURCE properties directly — 'investor' (any string field) or 'name~investor' (a specific field), case-insensitive substring

/** R1 — the domain discriminator. "Companies" = company; Career/Health = life; "Investor-facing" = work. */
export type SyntheticDomainKind = 'life' | 'company' | 'work' | 'custom';

export interface SyntheticDomainFilter {
  type: SyntheticDomainFilterType;
  values: string[];
}

export interface SyntheticDomainBinding {
  version: 1;
  combine: 'any' | 'all';
  filters: SyntheticDomainFilter[];
}

export interface SyntheticDomain {
  id: SyntheticDomainId;
  /** NULL = cross-workspace (visibility must be 'operator_only') */
  workspace_id: WorkspaceId | null;
  slug: string;
  label: string;
  description: string | null;
  owner_user_id: UserId;
  visibility: SyntheticDomainVisibility;
  edit_role: SyntheticDomainEditRole;
  binding: SyntheticDomainBinding;
  binding_version: number;
  source_domains: DomainId[];
  derivation_fingerprint: string | null;
  derivation_version: number;
  derivative_mutation_allowed: SyntheticDerivativeMutationKind[];
  status: SyntheticDomainStatus;
  /** R1 — domain discriminator (life|company|work|custom). Tenant-safe. */
  kind: SyntheticDomainKind;
  /** R1 — one-way mirror-lens backref to an external MB-P life-domain node (kind=life only). Construction IP — stripped from tenants. */
  source_domain_id: DomainId | null;
  /** LEM-v3 forward-compat — populated by PR-3+ workers */
  has_roadmap: boolean;
  goal_count: number;
  open_recommendation_count: number;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
  binding_updated_at: string | null;
  binding_updated_by: UserId | null;
}

export interface SyntheticDomainCreateInput {
  id?: SyntheticDomainId;
  workspace_id: WorkspaceId | null;
  slug: string;
  label: string;
  description?: string | null;
  owner_user_id?: UserId;
  visibility?: SyntheticDomainVisibility;
  edit_role?: SyntheticDomainEditRole;
  binding: SyntheticDomainBinding;
  source_domains?: DomainId[];
  derivation_fingerprint?: string | null;
  derivation_version?: number;
  derivative_mutation_allowed?: SyntheticDerivativeMutationKind[];
  metadata?: Record<string, any>;
  /** R1 — domain discriminator. Defaults to 'work' when omitted. */
  kind?: SyntheticDomainKind;
  /** R1 — mirror-lens backref (kind=life only). */
  source_domain_id?: DomainId | null;
}

export interface SyntheticDomainListOpts {
  /** Filter to a single workspace (omit to include cross-workspace if caller is operator) */
  workspace_id?: WorkspaceId | null;
  status?: SyntheticDomainStatus;
  include_membership_count?: boolean;
  limit?: number;
}

export interface SyntheticDomainMembership {
  domain_id: SyntheticDomainId;
  workspace_id: WorkspaceId;
  project_id: ProjectId;
  computed_at: string;
}
