// synthetic-domain-store.ts · R49' synthetic-domain CRUD + membership recompute.
//
// Authority: DATABASE_SCHEMA_V1.md (synthetic_domains, synthetic_domain_membership) ·
// LEM-v3 PR-1. Lifted verbatim out of WorkersDalAdapter (Stage 3.1, F10) to decompose
// the DAL god-object; behaviour is byte-for-byte identical to the prior inline methods.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). Audit-log
// writes are performed inline here with the SAME INSERT shape WorkersDalAdapter.appendAuditLog
// uses (mirrors customer-provisioning-store, which also writes audit_logs directly), so the
// public appendAuditLog method stays on the class and behaviour is unchanged.

import { makeError } from './shared-helpers';
import {
  DEFAULT_SYNTHETIC_DERIVATIVE_MUTATIONS,
  computeSyntheticDerivationFingerprint,
  normalizeSyntheticSourceDomains,
} from './synthetic-domain-identity';
import type {
  WorkspaceId,
  UserId,
  Project,
  SyntheticDomain,
  SyntheticDomainId,
  SyntheticDomainCreateInput,
  SyntheticDomainListOpts,
  SyntheticDomainBinding,
  SyntheticDomainFilter,
  AuditLogInput,
} from './types';
import type { Sql } from '../db/client';

// ------------------------------------------------------------
// Internal helpers (lifted verbatim from WorkersDalAdapter)
// ------------------------------------------------------------

/** Mirrors WorkersDalAdapter.appendAuditLog INSERT exactly so audit rows are identical. */
async function appendAuditLogRow(sql: Sql, entry: AuditLogInput): Promise<void> {
  await sql/*sql*/`
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, metadata)
    VALUES (
      ${entry.actor_user_id},
      ${entry.action}::text,
      ${entry.target_type}::text,
      ${entry.target_id},
      ${entry.workspace_id ?? null},
      ${entry.reason ?? null},
      ${JSON.stringify(entry.metadata ?? {})}::jsonb
    )
  `;
}

function normalizeProjectRowSd(row: Project): Project {
  return {
    ...row,
    description: row.description ?? null,
    metadata: row.metadata ?? {},
    scope_binding: row.scope_binding ?? null,
    scope_binding_updated_at: row.scope_binding_updated_at ?? null,
    scope_binding_updated_by: row.scope_binding_updated_by ?? null,
    parent_project_id: row.parent_project_id ?? null,
  };
}

function normalizeSyntheticDomainRow(row: SyntheticDomain): SyntheticDomain {
  return {
    ...row,
    description: row.description ?? null,
    binding: row.binding ?? { version: 1, combine: 'any', filters: [] },
    binding_version: row.binding_version ?? 1,
    source_domains: Array.isArray(row.source_domains) ? row.source_domains : [],
    derivation_fingerprint: row.derivation_fingerprint ?? null,
    derivation_version: row.derivation_version ?? 1,
    derivative_mutation_allowed: Array.isArray(row.derivative_mutation_allowed)
      ? row.derivative_mutation_allowed
      : DEFAULT_SYNTHETIC_DERIVATIVE_MUTATIONS,
    has_roadmap: row.has_roadmap ?? false,
    goal_count: row.goal_count ?? 0,
    open_recommendation_count: row.open_recommendation_count ?? 0,
    metadata: row.metadata ?? {},
    binding_updated_at: row.binding_updated_at ?? null,
    binding_updated_by: row.binding_updated_by ?? null,
    // R1 — discriminator + mirror-lens backref (default to the pre-028 implicit shape)
    kind: row.kind ?? 'work',
    source_domain_id: row.source_domain_id ?? null,
  };
}

const SYNTHETIC_FILTER_TYPES = new Set([
  'workspace_id_in', 'domain_id_in', 'parent_project_id_in', 'status_in', 'tag_in', 'metadata_path',
  // R1 — source-aware filters: a lens can match a project's CONNECTED SOURCE directly,
  // robust even without pre-tagging.
  'source_kind_in', 'source_ref_path',
]);

/** R1 — the source-aware filter types that require loading project_source_bindings. */
const SOURCE_AWARE_FILTER_TYPES = new Set(['source_kind_in', 'source_ref_path']);

function validateSyntheticBindingThrowing(input: unknown): void {
  if (!input || typeof input !== 'object') {
    throw makeError('VALIDATION_ERROR', 'binding must be an object', 400);
  }
  const b = input as Record<string, unknown>;
  if (b.version !== 1) throw makeError('VALIDATION_ERROR', 'binding.version must be 1', 400);
  if (b.combine !== 'any' && b.combine !== 'all') {
    throw makeError('VALIDATION_ERROR', 'binding.combine must be "any" or "all"', 400);
  }
  if (!Array.isArray(b.filters)) throw makeError('VALIDATION_ERROR', 'binding.filters must be an array', 400);
  if ((b.filters as unknown[]).length === 0) {
    throw makeError('VALIDATION_ERROR', 'binding.filters must contain at least 1 filter', 400);
  }
  if ((b.filters as unknown[]).length > 20) {
    throw makeError('VALIDATION_ERROR', 'binding.filters max length is 20', 400);
  }
  for (let i = 0; i < (b.filters as unknown[]).length; i++) {
    const f = (b.filters as unknown[])[i] as Record<string, unknown>;
    if (!f || typeof f !== 'object') throw makeError('VALIDATION_ERROR', `filters[${i}] must be an object`, 400);
    if (typeof f.type !== 'string' || !SYNTHETIC_FILTER_TYPES.has(f.type as string)) {
      throw makeError('VALIDATION_ERROR', `filters[${i}].type must be one of: ${[...SYNTHETIC_FILTER_TYPES].join(', ')}`, 400);
    }
    if (!Array.isArray(f.values) || (f.values as unknown[]).length === 0) {
      throw makeError('VALIDATION_ERROR', `filters[${i}].values must be a non-empty array`, 400);
    }
    if ((f.values as unknown[]).length > 100) {
      throw makeError('VALIDATION_ERROR', `filters[${i}].values max length is 100`, 400);
    }
    for (const v of f.values as unknown[]) {
      if (typeof v !== 'string' || v.length === 0 || v.length > 300) {
        throw makeError('VALIDATION_ERROR', `filters[${i}].values must be non-empty strings up to 300 chars`, 400);
      }
    }
  }
}

function collectSdFilter(binding: SyntheticDomainBinding, type: string): string[] {
  const out: string[] = [];
  for (const f of binding.filters) if (f.type === type) for (const v of f.values) out.push(v);
  return out;
}

function projectTags(p: Project): string[] {
  const meta = (p.metadata ?? {}) as Record<string, unknown>;
  const t = meta.tags;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

/** R1 — a project's connected sources, attached in-memory for source-aware filter evaluation. */
export interface SourceBindingLite {
  source_kind: string;
  source_ref: Record<string, unknown>;
}
/** R1 — a candidate project augmented with its source bindings (pure, in-memory; never persisted). */
export type CandidateProject = Project & { source_bindings?: SourceBindingLite[] };

/** R1 — lowercased haystack of a source_ref's string-valued fields (name/path/description/repo/url/...). */
function sourceRefHaystack(ref: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const v of Object.values(ref ?? {})) if (typeof v === 'string') parts.push(v);
  return parts.join('  ').toLowerCase();
}

/** R1 — evaluate a `source_ref_path` term: 'name~investor' (a specific field) or 'investor' (any field). Case-insensitive substring. */
function sourceRefMatches(b: SourceBindingLite, term: string): boolean {
  const tildeIdx = term.indexOf('~');
  if (tildeIdx > 0) {
    const field = term.slice(0, tildeIdx);
    const needle = term.slice(tildeIdx + 1).toLowerCase();
    if (needle.length === 0) return false;
    const raw = (b.source_ref ?? {})[field];
    return typeof raw === 'string' && raw.toLowerCase().includes(needle);
  }
  const needle = term.toLowerCase();
  if (needle.length === 0) return false;
  return sourceRefHaystack(b.source_ref).includes(needle);
}

function evaluateFilter(p: CandidateProject, f: SyntheticDomainFilter): boolean {
  switch (f.type) {
    case 'workspace_id_in':
      return f.values.includes(p.workspace_id);
    case 'parent_project_id_in':
      return p.parent_project_id != null && f.values.includes(p.parent_project_id);
    case 'status_in':
      return f.values.includes(p.status);
    case 'tag_in': {
      const tags = projectTags(p);
      return f.values.some((v) => tags.includes(v));
    }
    case 'metadata_path': {
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      return f.values.some((kv) => {
        const eqIdx = kv.indexOf('=');
        if (eqIdx <= 0) return false;
        const key = kv.slice(0, eqIdx);
        const val = kv.slice(eqIdx + 1);
        return String(meta[key] ?? '') === val;
      });
    }
    case 'source_kind_in': {
      // R1 — match a project whose ANY connected source kind is in values.
      const bindings = p.source_bindings ?? [];
      return bindings.some((b) => f.values.includes(b.source_kind));
    }
    case 'source_ref_path': {
      // R1 — match SOURCE properties directly (robust without pre-tagging).
      const bindings = p.source_bindings ?? [];
      return f.values.some((term) => bindings.some((b) => sourceRefMatches(b, term)));
    }
    default:
      return false;
  }
}

/** Exported for unit testing the pure binding-evaluation logic (incl. the R1 source-aware filters). */
export function evaluateSyntheticBinding(p: CandidateProject, binding: SyntheticDomainBinding): boolean {
  if (binding.filters.length === 0) return false;
  const results = binding.filters.map((f) => evaluateFilter(p, f));
  return binding.combine === 'all' ? results.every(Boolean) : results.some(Boolean);
}

/** R1 — true when the binding contains any source-aware filter (→ source bindings must be loaded). */
function bindingNeedsSourceBindings(binding: SyntheticDomainBinding): boolean {
  return binding.filters.some((f) => SOURCE_AWARE_FILTER_TYPES.has(f.type));
}

/** R1 — load project_source_bindings for the candidate projects and attach in-memory. */
async function attachSourceBindings(sql: Sql, projects: CandidateProject[]): Promise<CandidateProject[]> {
  if (projects.length === 0) return projects;
  const ids = projects.map((p) => p.id);
  const rows = (await sql/*sql*/`
    SELECT project_id, source_kind, source_ref
    FROM project_source_bindings
    WHERE project_id = ANY(${ids}::text[])
  `) as Array<{ project_id: string; source_kind: string; source_ref: Record<string, unknown> | null }>;
  const byProject = new Map<string, SourceBindingLite[]>();
  for (const r of rows) {
    const list = byProject.get(r.project_id) ?? [];
    list.push({ source_kind: r.source_kind, source_ref: r.source_ref ?? {} });
    byProject.set(r.project_id, list);
  }
  for (const p of projects) p.source_bindings = byProject.get(p.id) ?? [];
  return projects;
}

async function listCandidateProjects(
  sql: Sql,
  domainWorkspaceId: WorkspaceId | null,
  workspaceIdsFilter: string[],
): Promise<Project[]> {
  if (workspaceIdsFilter.length > 0) {
    const rows = await sql/*sql*/`
      SELECT id, workspace_id, name, status, description, metadata,
             scope_binding, scope_binding_updated_at, scope_binding_updated_by,
             parent_project_id, created_at, updated_at
      FROM projects WHERE workspace_id = ANY(${workspaceIdsFilter}::text[])
    ` as Project[];
    return rows.map(normalizeProjectRowSd);
  }
  if (domainWorkspaceId === null) {
    const rows = await sql/*sql*/`
      SELECT id, workspace_id, name, status, description, metadata,
             scope_binding, scope_binding_updated_at, scope_binding_updated_by,
             parent_project_id, created_at, updated_at
      FROM projects
    ` as Project[];
    return rows.map(normalizeProjectRowSd);
  }
  const rows = await sql/*sql*/`
    SELECT id, workspace_id, name, status, description, metadata,
           scope_binding, scope_binding_updated_at, scope_binding_updated_by,
           parent_project_id, created_at, updated_at
    FROM projects WHERE workspace_id = ${domainWorkspaceId}
  ` as Project[];
  return rows.map(normalizeProjectRowSd);
}

/**
 * Internal · evaluates the binding against the projects table and rewrites
 * synthetic_domain_membership rows for this domain. Returns new member count.
 */
async function recomputeMembership(sql: Sql, domain: SyntheticDomain): Promise<number> {
  await sql/*sql*/`DELETE FROM synthetic_domain_membership WHERE domain_id = ${domain.id}`;

  const workspaceIdsFilter = collectSdFilter(domain.binding, 'workspace_id_in');
  let candidateRows: CandidateProject[] = await listCandidateProjects(sql, domain.workspace_id, workspaceIdsFilter);

  // R1 — only pay the extra query when the binding actually uses a source-aware filter.
  if (bindingNeedsSourceBindings(domain.binding)) {
    candidateRows = await attachSourceBindings(sql, candidateRows);
  }

  const matched = candidateRows.filter((p) => evaluateSyntheticBinding(p, domain.binding));
  if (matched.length === 0) return 0;

  // Bulk insert via UNNEST of parallel string arrays
  const projectIds = matched.map((p) => p.id);
  const workspaceIds = matched.map((p) => p.workspace_id);
  await sql/*sql*/`
    INSERT INTO synthetic_domain_membership (domain_id, workspace_id, project_id, computed_at)
    SELECT ${domain.id}, ws, pid, now()
    FROM unnest(${workspaceIds}::text[], ${projectIds}::text[]) AS t(ws, pid)
    ON CONFLICT (domain_id, project_id) DO NOTHING
  `;
  return matched.length;
}

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function createSyntheticDomainRow(
  sql: Sql,
  input: SyntheticDomainCreateInput,
  actorUserId: UserId,
): Promise<SyntheticDomain> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!input.slug || input.slug.length > 100) throw makeError('VALIDATION_ERROR', 'slug 1-100 chars required', 400);
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(input.slug)) {
    throw makeError('VALIDATION_ERROR', 'slug must match kebab-case [a-z0-9-]', 400);
  }
  if (!input.label || input.label.length > 200) throw makeError('VALIDATION_ERROR', 'label 1-200 chars required', 400);
  validateSyntheticBindingThrowing(input.binding);

  const visibility = input.visibility ?? 'workspace';
  if (input.workspace_id === null && visibility !== 'operator_only') {
    throw makeError('VALIDATION_ERROR', 'cross-workspace synthetic domains must be operator_only visible', 400);
  }

  const newId = input.id && input.id.length > 0
    ? input.id
    : `sd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ownerUserId = input.owner_user_id ?? actorUserId;
  const editRole = input.edit_role ?? 'operator';
  const sourceDomains = normalizeSyntheticSourceDomains(input.source_domains, input.binding, input.workspace_id, input.slug);
  const derivationFingerprint = input.derivation_fingerprint ?? await computeSyntheticDerivationFingerprint({
    source_domains: sourceDomains,
    binding: input.binding,
    purpose_key: input.slug,
  });
  const derivativeMutationAllowed = input.derivative_mutation_allowed ?? DEFAULT_SYNTHETIC_DERIVATIVE_MUTATIONS;

  const rows = await sql/*sql*/`
    INSERT INTO synthetic_domains (
      id, workspace_id, slug, label, description, owner_user_id, visibility, edit_role,
      binding, binding_version, source_domains, derivation_fingerprint, derivation_version,
      derivative_mutation_allowed, status, metadata, kind, source_domain_id,
      binding_updated_at, binding_updated_by
    ) VALUES (
      ${newId},
      ${input.workspace_id},
      ${input.slug},
      ${input.label},
      ${input.description ?? null},
      ${ownerUserId},
      ${visibility},
      ${editRole},
      ${JSON.stringify(input.binding)}::jsonb,
      1,
      ${sourceDomains as unknown as string[]},
      ${derivationFingerprint},
      ${input.derivation_version ?? 1},
      ${derivativeMutationAllowed as unknown as string[]},
      'active',
      ${JSON.stringify(input.metadata ?? {})}::jsonb,
      ${input.kind ?? 'work'},
      ${input.source_domain_id ?? null},
      now(),
      ${actorUserId}
    )
    ON CONFLICT (COALESCE(workspace_id, '__cross__'), slug) DO UPDATE SET
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      binding = EXCLUDED.binding,
      source_domains = EXCLUDED.source_domains,
      derivation_fingerprint = EXCLUDED.derivation_fingerprint,
      derivation_version = CASE
        WHEN synthetic_domains.derivation_fingerprint IS DISTINCT FROM EXCLUDED.derivation_fingerprint
        THEN synthetic_domains.derivation_version + 1
        ELSE synthetic_domains.derivation_version
      END,
      derivative_mutation_allowed = EXCLUDED.derivative_mutation_allowed,
      kind = EXCLUDED.kind,
      source_domain_id = EXCLUDED.source_domain_id,
      binding_version = synthetic_domains.binding_version + 1,
      updated_at = now(),
      binding_updated_at = now(),
      binding_updated_by = EXCLUDED.binding_updated_by
    RETURNING id, workspace_id, slug, label, description, owner_user_id,
              visibility, edit_role, binding, binding_version, source_domains,
              derivation_fingerprint, derivation_version, derivative_mutation_allowed, status,
              has_roadmap, goal_count, open_recommendation_count, metadata, kind, source_domain_id,
              created_at, updated_at, binding_updated_at, binding_updated_by
  ` as SyntheticDomain[];
  const domain = normalizeSyntheticDomainRow(rows[0]!);

  await recomputeMembership(sql, domain);

  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'synthetic_domain_create',
    target_type: 'synthetic_domain',
    target_id: domain.id,
    workspace_id: domain.workspace_id ?? null,
    metadata: {
      slug: domain.slug,
      label: domain.label,
      binding_version: domain.binding_version,
      source_domains: domain.source_domains,
      derivation_fingerprint: domain.derivation_fingerprint,
      derivation_version: domain.derivation_version,
    },
  });
  return domain;
}

export async function listSyntheticDomainsRow(
  sql: Sql,
  opts: SyntheticDomainListOpts,
  callerUserId: UserId,
  isOperator: boolean,
): Promise<SyntheticDomain[]> {
  if (!callerUserId) throw makeError('UNAUTHORIZED', 'user_id required', 401);
  const wantsCrossWorkspace = opts.workspace_id === null;
  if (wantsCrossWorkspace && !isOperator) {
    throw makeError('FORBIDDEN', 'cross-workspace synthetic domains visible to operators only', 403);
  }
  const status = opts.status ?? 'active';
  const limit = Math.min(opts.limit ?? 200, 500);

  if (wantsCrossWorkspace) {
    const rows = await sql/*sql*/`
      SELECT id, workspace_id, slug, label, description, owner_user_id,
             visibility, edit_role, binding, binding_version, status,
             source_domains, derivation_fingerprint, derivation_version, derivative_mutation_allowed,
             has_roadmap, goal_count, open_recommendation_count, metadata, kind, source_domain_id,
             created_at, updated_at, binding_updated_at, binding_updated_by
      FROM synthetic_domains
      WHERE workspace_id IS NULL AND status = ${status}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    ` as SyntheticDomain[];
    return rows.map(normalizeSyntheticDomainRow);
  }

  if (opts.workspace_id) {
    const rows = await sql/*sql*/`
      SELECT id, workspace_id, slug, label, description, owner_user_id,
             visibility, edit_role, binding, binding_version, status,
             source_domains, derivation_fingerprint, derivation_version, derivative_mutation_allowed,
             has_roadmap, goal_count, open_recommendation_count, metadata, kind, source_domain_id,
             created_at, updated_at, binding_updated_at, binding_updated_by
      FROM synthetic_domains
      WHERE (workspace_id = ${opts.workspace_id}
             OR (workspace_id IS NULL AND ${isOperator}))
        AND status = ${status}
        AND (visibility != 'operator_only' OR ${isOperator})
      ORDER BY updated_at DESC
      LIMIT ${limit}
    ` as SyntheticDomain[];
    return rows.map(normalizeSyntheticDomainRow);
  }

  return [];
}

export async function getSyntheticDomainRow(
  sql: Sql,
  id: SyntheticDomainId,
  callerUserId: UserId,
  callerWorkspaceId: WorkspaceId,
  isOperator: boolean,
): Promise<SyntheticDomain | null> {
  if (!callerUserId) throw makeError('UNAUTHORIZED', 'user_id required', 401);
  const rows = await sql/*sql*/`
    SELECT id, workspace_id, slug, label, description, owner_user_id,
           visibility, edit_role, binding, binding_version, status,
           source_domains, derivation_fingerprint, derivation_version, derivative_mutation_allowed,
           has_roadmap, goal_count, open_recommendation_count, metadata, kind, source_domain_id,
           created_at, updated_at, binding_updated_at, binding_updated_by
    FROM synthetic_domains
    WHERE id = ${id}
    LIMIT 1
  ` as SyntheticDomain[];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (row.workspace_id === null && !isOperator) return null;
  if (row.workspace_id !== null && row.workspace_id !== callerWorkspaceId) return null;
  if (row.visibility === 'operator_only' && !isOperator) return null;
  return normalizeSyntheticDomainRow(row);
}

export async function updateSyntheticDomainBindingRow(
  sql: Sql,
  id: SyntheticDomainId,
  binding: SyntheticDomainBinding,
  actorUserId: UserId,
): Promise<SyntheticDomain> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  validateSyntheticBindingThrowing(binding);
  const currentRows = await sql/*sql*/`
    SELECT id, workspace_id, slug, source_domains
    FROM synthetic_domains
    WHERE id = ${id}
    LIMIT 1
  ` as Array<Pick<SyntheticDomain, 'id' | 'workspace_id' | 'slug' | 'source_domains'>>;
  if (currentRows.length === 0) throw makeError('NOT_FOUND', `synthetic_domain ${id} not found`, 404);
  const current = currentRows[0]!;
  const sourceDomains = normalizeSyntheticSourceDomains(current.source_domains, binding, current.workspace_id, current.slug);
  const derivationFingerprint = await computeSyntheticDerivationFingerprint({
    source_domains: sourceDomains,
    binding,
    purpose_key: current.slug,
  });
  const rows = await sql/*sql*/`
    UPDATE synthetic_domains
    SET binding = ${JSON.stringify(binding)}::jsonb,
        binding_version = binding_version + 1,
        source_domains = ${sourceDomains as unknown as string[]},
        derivation_fingerprint = ${derivationFingerprint},
        derivation_version = CASE
          WHEN derivation_fingerprint IS DISTINCT FROM ${derivationFingerprint}
          THEN derivation_version + 1
          ELSE derivation_version
        END,
        binding_updated_at = now(),
        binding_updated_by = ${actorUserId},
        updated_at = now()
    WHERE id = ${id}
    RETURNING id, workspace_id, slug, label, description, owner_user_id,
              visibility, edit_role, binding, binding_version, source_domains,
              derivation_fingerprint, derivation_version, derivative_mutation_allowed, status,
              has_roadmap, goal_count, open_recommendation_count, metadata, kind, source_domain_id,
              created_at, updated_at, binding_updated_at, binding_updated_by
  ` as SyntheticDomain[];
  if (rows.length === 0) throw makeError('NOT_FOUND', `synthetic_domain ${id} not found`, 404);
  const domain = normalizeSyntheticDomainRow(rows[0]!);
  await recomputeMembership(sql, domain);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'synthetic_domain_update_binding',
    target_type: 'synthetic_domain',
    target_id: domain.id,
    workspace_id: domain.workspace_id ?? null,
    metadata: {
      binding_version: domain.binding_version,
      filter_count: binding.filters.length,
      source_domains: domain.source_domains,
      derivation_fingerprint: domain.derivation_fingerprint,
      derivation_version: domain.derivation_version,
    },
  });
  return domain;
}

export async function archiveSyntheticDomainRow(
  sql: Sql,
  id: SyntheticDomainId,
  actorUserId: UserId,
): Promise<SyntheticDomain> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  const rows = await sql/*sql*/`
    UPDATE synthetic_domains
    SET status = 'archived', updated_at = now()
    WHERE id = ${id}
    RETURNING id, workspace_id, slug, label, description, owner_user_id,
              visibility, edit_role, binding, binding_version, source_domains,
              derivation_fingerprint, derivation_version, derivative_mutation_allowed, status,
              has_roadmap, goal_count, open_recommendation_count, metadata, kind, source_domain_id,
              created_at, updated_at, binding_updated_at, binding_updated_by
  ` as SyntheticDomain[];
  if (rows.length === 0) throw makeError('NOT_FOUND', `synthetic_domain ${id} not found`, 404);
  const domain = normalizeSyntheticDomainRow(rows[0]!);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'synthetic_domain_archive',
    target_type: 'synthetic_domain',
    target_id: domain.id,
    workspace_id: domain.workspace_id ?? null,
    metadata: {},
  });
  return domain;
}

export async function refreshSyntheticDomainMembershipRow(
  sql: Sql,
  id: SyntheticDomainId,
  actorUserId: UserId,
): Promise<{ domain_id: SyntheticDomainId; member_count: number }> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  const rows = await sql/*sql*/`
    SELECT id, workspace_id, slug, label, description, owner_user_id,
           visibility, edit_role, binding, binding_version, source_domains,
           derivation_fingerprint, derivation_version, derivative_mutation_allowed, status,
           has_roadmap, goal_count, open_recommendation_count, metadata, kind, source_domain_id,
           created_at, updated_at, binding_updated_at, binding_updated_by
    FROM synthetic_domains WHERE id = ${id} LIMIT 1
  ` as SyntheticDomain[];
  if (rows.length === 0) throw makeError('NOT_FOUND', `synthetic_domain ${id} not found`, 404);
  const domain = normalizeSyntheticDomainRow(rows[0]!);
  const count = await recomputeMembership(sql, domain);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'synthetic_domain_refresh_membership',
    target_type: 'synthetic_domain',
    target_id: domain.id,
    workspace_id: domain.workspace_id ?? null,
    metadata: { member_count: count },
  });
  return { domain_id: domain.id, member_count: count };
}

export async function listSyntheticDomainMembersRow(
  sql: Sql,
  id: SyntheticDomainId,
  callerWorkspaceId: WorkspaceId,
  isOperator: boolean,
): Promise<Project[]> {
  const dRows = await sql/*sql*/`
    SELECT workspace_id, visibility FROM synthetic_domains WHERE id = ${id} LIMIT 1
  ` as Array<{ workspace_id: string | null; visibility: string }>;
  if (dRows.length === 0) throw makeError('NOT_FOUND', `synthetic_domain ${id} not found`, 404);
  const d = dRows[0]!;
  if (d.workspace_id === null && !isOperator) {
    throw makeError('FORBIDDEN', 'cross-workspace synthetic domain visible to operators only', 403);
  }
  if (d.workspace_id !== null && d.workspace_id !== callerWorkspaceId) {
    throw makeError('FORBIDDEN', 'synthetic domain belongs to another workspace', 403);
  }
  if (d.visibility === 'operator_only' && !isOperator) {
    throw makeError('FORBIDDEN', 'synthetic domain is operator-only', 403);
  }
  const projectRows = await sql/*sql*/`
    SELECT p.id, p.workspace_id, p.name, p.status, p.description, p.metadata,
           p.scope_binding, p.scope_binding_updated_at, p.scope_binding_updated_by,
           p.parent_project_id, p.created_at, p.updated_at
    FROM synthetic_domain_membership m
    JOIN projects p ON p.id = m.project_id
    WHERE m.domain_id = ${id}
    ORDER BY p.updated_at DESC
    LIMIT 500
  ` as Project[];
  return projectRows.map(normalizeProjectRowSd);
}
