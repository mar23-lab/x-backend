// project-store.ts · project CRUD + nesting + scope-binding + source-binding group.
//
// Authority: DATABASE_SCHEMA_V1.md (projects, project_source_bindings, audit_logs) ·
// API_CONTRACT_V1.md · AUTH_TENANCY_MODEL.md. Lifted verbatim out of WorkersDalAdapter
// (Stage 3.1, F10) to decompose the DAL god-object; behaviour is byte-for-byte identical
// to the prior inline methods.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). assertWorkspaceScope
// is imported from ./DalAdapter (same call shape). Audit-log writes are performed inline here with
// the SAME INSERT shape the inline methods used (the (actor_user_id, action, target_type, target_id,
// workspace_id, reason) column form — mirrors the original try/void-e best-effort writes), so behaviour
// is unchanged. getProjectRow stays callable from the DAL (listEventsForProjectScope / getProjectProvenance
// still go through this.getProject, which delegates here). normalizeProjectRow is SHARED and is kept on the
// DAL too; an identical private copy lives here so this module has no back-reference to the class.

import { assertWorkspaceScope } from './DalAdapter';
import { makeError, randomNanoid } from './shared-helpers';
// 045 · project LIST reads run inside the workspace-GUC transaction so the RLS-subject client
// (rlsSql) is DB-filtered. INERT until XLOOOP_RLS_APP_DATABASE_URL is set (rlsSql defaults to owner
// sql → byte-identical; owner bypasses RLS, the WHERE workspace_id still scopes).
import { withWorkspaceRlsContext } from './operational-spine-store';
import type {
  WorkspaceId,
  UserId,
  ProjectId,
  Project,
  ProjectStatus,
  ProjectListOpts,
  ProjectScopeBinding,
  ProjectSourceBinding,
  ProjectSourceBindingInput,
  ProjectSourceBindingPatch,
  ProjectSourceBindingStatus,
  ProjectSourceKind,
  ProjectSourceReadPolicy,
  ProjectCreateInput,
} from './types';
import type { Sql } from '../db/client';

// ------------------------------------------------------------
// Internal helpers (lifted verbatim from WorkersDalAdapter)
// ------------------------------------------------------------

/** Mirrors WorkersDalAdapter.normalizeProjectRow exactly (kept on the DAL too — shared family). */
function normalizeProjectRow(row: Project): Project {
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

const PROJECT_SOURCE_KINDS = new Set<ProjectSourceKind>([
  'github_repo',
  'google_drive_folder',
  'desktop_folder',
  'manual',
]);

const PROJECT_SOURCE_STATUSES = new Set<ProjectSourceBindingStatus>([
  'pending_auth',
  'connected',
  'reconnect_required',
  'disabled_preview',
  'archived',
]);

const PROJECT_SOURCE_READ_POLICIES = new Set<ProjectSourceReadPolicy>([
  'metadata_only',
  'proposal_only',
  'read_only',
]);

function validateProjectSourceBindingInput(input: ProjectSourceBindingInput): void {
  if (!input || typeof input !== 'object') throw makeError('VALIDATION_ERROR', 'binding input must be an object', 400);
  if (!PROJECT_SOURCE_KINDS.has(input.source_kind)) {
    throw makeError('VALIDATION_ERROR', `source_kind must be one of: ${[...PROJECT_SOURCE_KINDS].join(', ')}`, 400);
  }
  if (input.status !== undefined && !PROJECT_SOURCE_STATUSES.has(input.status)) {
    throw makeError('VALIDATION_ERROR', `status must be one of: ${[...PROJECT_SOURCE_STATUSES].join(', ')}`, 400);
  }
  if (input.read_policy !== undefined && !PROJECT_SOURCE_READ_POLICIES.has(input.read_policy)) {
    throw makeError('VALIDATION_ERROR', `read_policy must be one of: ${[...PROJECT_SOURCE_READ_POLICIES].join(', ')}`, 400);
  }
  if (input.source_ref !== undefined && (!input.source_ref || typeof input.source_ref !== 'object' || Array.isArray(input.source_ref))) {
    throw makeError('VALIDATION_ERROR', 'source_ref must be an object when provided', 400);
  }
  // W1'-PR4 · domain_id is optional; when present it must be a non-empty string (the lens id).
  if (input.domain_id !== undefined && input.domain_id !== null && (typeof input.domain_id !== 'string' || input.domain_id.length === 0 || input.domain_id.length > 128)) {
    throw makeError('VALIDATION_ERROR', 'domain_id must be a non-empty string (≤128 chars) when provided', 400);
  }
}

function validateProjectSourceBindingPatch(patch: ProjectSourceBindingPatch): void {
  if (!patch || typeof patch !== 'object') throw makeError('VALIDATION_ERROR', 'binding patch must be an object', 400);
  if (patch.status !== undefined && !PROJECT_SOURCE_STATUSES.has(patch.status)) {
    throw makeError('VALIDATION_ERROR', `status must be one of: ${[...PROJECT_SOURCE_STATUSES].join(', ')}`, 400);
  }
  if (patch.read_policy !== undefined && !PROJECT_SOURCE_READ_POLICIES.has(patch.read_policy)) {
    throw makeError('VALIDATION_ERROR', `read_policy must be one of: ${[...PROJECT_SOURCE_READ_POLICIES].join(', ')}`, 400);
  }
  if (patch.source_ref !== undefined && (!patch.source_ref || typeof patch.source_ref !== 'object' || Array.isArray(patch.source_ref))) {
    throw makeError('VALIDATION_ERROR', 'source_ref must be an object when provided', 400);
  }
}

function normalizeProjectSourceBindingRow(row: ProjectSourceBinding): ProjectSourceBinding {
  const toIso = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  };
  return {
    ...row,
    binding_id: row.binding_id || row.id,
    // W1'-PR4 · domain lens backref (migration 033); null = project-only binding.
    domain_id: row.domain_id ?? null,
    user_source_connection_id: row.user_source_connection_id ?? null,
    source_ref: row.source_ref ?? {},
    connected_by: row.connected_by ?? null,
    connected_at: toIso(row.connected_at),
    last_verified_at: toIso(row.last_verified_at),
    reconnect_required_reason: row.reconnect_required_reason ?? null,
    metadata: row.metadata ?? {},
    created_at: toIso(row.created_at) ?? '',
    updated_at: toIso(row.updated_at) ?? '',
    // R57 Phase 2 · folder facts pass through when the LEFT JOIN supplied them (folder rows only).
    folder_file_count: (row.folder_file_count == null) ? null : Number(row.folder_file_count),
    folder_synced_at: row.folder_synced_at ? toIso(row.folder_synced_at) : null,
  };
}

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function listProjectsRow(sql: Sql, workspaceId: WorkspaceId, opts: ProjectListOpts): Promise<Project[]> {
  assertWorkspaceScope(workspaceId);

  const statusFilter = opts.status ?? 'active';

  const [rows] = await withWorkspaceRlsContext<[Project[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
    SELECT id, workspace_id, name, status, description, metadata,
           scope_binding, scope_binding_updated_at, scope_binding_updated_by,
           parent_project_id, created_at, updated_at
    FROM projects
    WHERE workspace_id = ${workspaceId} AND status = ${statusFilter}
    ORDER BY created_at DESC
    LIMIT 500
  `,
  ], { readOnly: true });

  return rows.map(normalizeProjectRow);
}

export async function createProjectRow(
  sql: Sql,
  input: ProjectCreateInput,
  actorUserId: UserId,
): Promise<Project> {
  assertWorkspaceScope(input.workspace_id);
  if (!input.name || input.name.length > 200) throw makeError('VALIDATION_ERROR', 'name 1-200 chars required', 400);
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);

  if (input.parent_project_id) {
    // Same-workspace check + no immediate cycle (a project cannot parent itself)
    if (input.parent_project_id === input.id) {
      throw makeError('VALIDATION_ERROR', 'parent_project_id cannot equal id (cycle)', 400);
    }
    const parentRows = await sql/*sql*/`
      SELECT id, workspace_id FROM projects WHERE id = ${input.parent_project_id} LIMIT 1
    `as Array<{ id: string; workspace_id: string }>;
    if (parentRows.length === 0) throw makeError('NOT_FOUND', `parent project ${input.parent_project_id} not found`, 404);
    if (parentRows[0]!.workspace_id !== input.workspace_id) {
      throw makeError('VALIDATION_ERROR', 'parent_project_id must be in the same workspace', 400);
    }
  }

  const newId = input.id && input.id.length > 0
    ? input.id
    : `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const rows = await sql/*sql*/`
    INSERT INTO projects (id, workspace_id, name, status, description, metadata, parent_project_id)
    VALUES (${newId},
            ${input.workspace_id},
            ${input.name},
            ${input.status ?? 'active'},
            ${input.description ?? null},
            ${JSON.stringify(input.metadata ?? {})}::jsonb,
            ${input.parent_project_id ?? null})
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          status = EXCLUDED.status,
          description = EXCLUDED.description,
          metadata = EXCLUDED.metadata,
          parent_project_id = EXCLUDED.parent_project_id,
          updated_at = now()
    RETURNING id, workspace_id, name, status, description, metadata,
              scope_binding, scope_binding_updated_at, scope_binding_updated_by,
              parent_project_id, created_at, updated_at
  ` as Project[];

  return normalizeProjectRow(rows[0]!);
}

export async function listChildProjectsRow(sql: Sql, workspaceId: WorkspaceId, parentProjectId: ProjectId): Promise<Project[]> {
  assertWorkspaceScope(workspaceId);
  if (!parentProjectId) throw makeError('VALIDATION_ERROR', 'parent_project_id required', 400);
  const [rows] = await withWorkspaceRlsContext<[Project[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
    SELECT id, workspace_id, name, status, description, metadata,
           scope_binding, scope_binding_updated_at, scope_binding_updated_by,
           parent_project_id, created_at, updated_at
    FROM projects
    WHERE workspace_id = ${workspaceId} AND parent_project_id = ${parentProjectId}
    ORDER BY created_at DESC
    LIMIT 500
  `,
  ], { readOnly: true });
  return rows.map(normalizeProjectRow);
}

export async function getProjectRow(sql: Sql, workspaceId: WorkspaceId, projectId: ProjectId): Promise<Project | null> {
  assertWorkspaceScope(workspaceId);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);

  // 047-B · wrapped in the workspace-GUC transaction (completes projects RLS beyond the list reads).
  // All callers invoke this at top level (audited 260706: zero `.transaction()` nesting), so this is
  // always a fresh transaction — byte-identical for owner clients, DB-filtered for rlsSql.
  const [rows] = await withWorkspaceRlsContext<[Project[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
    SELECT id, workspace_id, name, status, description, metadata,
           scope_binding, scope_binding_updated_at, scope_binding_updated_by,
           parent_project_id, created_at, updated_at
    FROM projects
    WHERE id = ${projectId} AND workspace_id = ${workspaceId}
    LIMIT 1
  `,
  ], { readOnly: true });

  if (rows.length === 0) return null;
  return normalizeProjectRow(rows[0]!);
}

// R53-W4.x · operator overlay variant of getProjectRow. A project the VERIFIED
// platform owner OWNS can live in a workspace that is NOT their active Clerk org
// (mbp-private, x-docs). The strict workspace-scoped getProjectRow 404s such a
// project even though the operator owns it — the bug behind the scope-binding
// panel's "project <id> not found" diagnostic + the empty per-project view. This
// resolver looks the project up by id within the operator's OWN workspaces
// (workspaces.owner_user_id ∈ ownerUserIds) with NO JWT-workspace scope. Access is
// gated by the ROUTE (primary-owner identity == ownerUserId); the id set only
// EXPANDS scope, never grants entry. Fail-closed on an empty id set.
export async function getProjectForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  projectId: ProjectId,
): Promise<Project | null> {
  const ids = (Array.isArray(ownerUserIds) ? ownerUserIds : [ownerUserIds]).filter(Boolean);
  if (ids.length === 0) return null;
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);

  const rows = (await sql/*sql*/`
    SELECT p.id, p.workspace_id, p.name, p.status, p.description, p.metadata,
           p.scope_binding, p.scope_binding_updated_at, p.scope_binding_updated_by,
           p.parent_project_id, p.created_at, p.updated_at
    FROM projects p
    JOIN workspaces w ON w.id = p.workspace_id
    WHERE p.id = ${projectId} AND w.owner_user_id = ANY(${ids})
    LIMIT 1
  `) as Project[];

  if (rows.length === 0) return null;
  return normalizeProjectRow(rows[0]!);
}

export async function updateProjectScopeRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  binding: ProjectScopeBinding | null,
  actorUserId: UserId,
): Promise<Project> {
  assertWorkspaceScope(workspaceId);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor_user_id is required', 400);

  // Validate binding shape (defense in depth — route layer also checks).
  if (binding !== null) {
    if (binding.version !== 1) throw makeError('VALIDATION_ERROR', `unsupported scope_binding version: ${binding.version}`, 400);
    if (binding.combine !== 'all' && binding.combine !== 'any') {
      throw makeError('VALIDATION_ERROR', `combine must be "all" or "any"`, 400);
    }
    if (!Array.isArray(binding.filters)) {
      throw makeError('VALIDATION_ERROR', `filters must be an array`, 400);
    }
    for (const f of binding.filters) {
      if (!['actor_in', 'source_tool_in', 'status_in', 'visibility_in'].includes(f.type)) {
        throw makeError('VALIDATION_ERROR', `unknown filter type: ${(f as { type: string }).type}`, 400);
      }
      if (!Array.isArray(f.values) || f.values.length === 0) {
        throw makeError('VALIDATION_ERROR', `filter ${f.type} must have at least one value`, 400);
      }
    }
  }

  const rows = (await sql/*sql*/`
    UPDATE projects
       SET scope_binding = ${binding === null ? null : JSON.stringify(binding)}::jsonb,
           scope_binding_updated_at = now(),
           scope_binding_updated_by = ${actorUserId},
           updated_at = now()
     WHERE id = ${projectId} AND workspace_id = ${workspaceId}
     RETURNING id, workspace_id, name, status, description, metadata,
               scope_binding, scope_binding_updated_at, scope_binding_updated_by,
               created_at, updated_at
  `) as Project[];

  if (rows.length === 0) throw makeError('NOT_FOUND', `project ${projectId} not found in workspace ${workspaceId}`, 404);

  // Audit trail (non-critical)
  try {
    await sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      VALUES (${actorUserId}, 'project_scope_update', 'project', ${projectId}, ${workspaceId},
              ${binding === null ? 'cleared scope_binding' : `set scope_binding · ${binding.filters.length} filter(s) combine=${binding.combine}`})
    `;
  } catch (e) { void e; }

  return normalizeProjectRow(rows[0]!);
}

export async function updateProjectRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  patch: { name?: string; description?: string | null; status?: ProjectStatus },
  actorUserId: UserId,
): Promise<Project | null> {
  assertWorkspaceScope(workspaceId);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor_user_id is required', 400);

  const name = (typeof patch.name === 'string' && patch.name.trim()) ? patch.name.trim() : null;
  if (name !== null && name.length > 200) throw makeError('VALIDATION_ERROR', 'name max 200 chars', 400);
  const status = (typeof patch.status === 'string') ? patch.status : null;
  if (status !== null && !['active', 'paused', 'completed', 'archived'].includes(status)) {
    throw makeError('VALIDATION_ERROR', `invalid status: ${status}`, 400);
  }
  // description: undefined = leave; null/'' = leave (we never force-clear here); string = set.
  const description = (typeof patch.description === 'string' && patch.description.length > 0) ? patch.description : null;

  if (name === null && status === null && description === null) {
    throw makeError('VALIDATION_ERROR', 'nothing to update (provide name, description, and/or status)', 400);
  }

  const rows = (await sql/*sql*/`
    UPDATE projects
       SET name = COALESCE(${name}, name),
           description = COALESCE(${description}, description),
           status = COALESCE(${status}, status),
           updated_at = now()
     WHERE id = ${projectId} AND workspace_id = ${workspaceId}
     RETURNING id, workspace_id, name, status, description, metadata,
               scope_binding, scope_binding_updated_at, scope_binding_updated_by,
               parent_project_id, created_at, updated_at
  `) as Project[];

  if (rows.length === 0) return null;

  // Audit trail (non-critical).
  try {
    const action = status === 'archived' ? 'project_archive' : 'project_update';
    const reason = [
      name !== null ? 'renamed' : null,
      description !== null ? 'description edited' : null,
      status !== null ? `status=${status}` : null,
    ].filter(Boolean).join(' · ') || 'updated';
    await sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      VALUES (${actorUserId}, ${action}, 'project', ${projectId}, ${workspaceId}, ${reason})
    `;
  } catch (e) { void e; }

  return normalizeProjectRow(rows[0]!);
}

export async function listProjectSourceBindingsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
): Promise<ProjectSourceBinding[]> {
  assertWorkspaceScope(workspaceId);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);

  const proj = await getProjectRow(sql, workspaceId, projectId);
  if (!proj) throw makeError('NOT_FOUND', `project ${projectId} not found in workspace ${workspaceId}`, 404);

  // R57 folders-into-workspace Phase 2 · LEFT JOIN folder_snapshots so desktop_folder rows carry
  // file-count + last-synced (the management parity the standalone Folders screen provided). The
  // join mirrors listFolderBindingsForOperatorRow; additive (non-folder kinds get NULL → null).
  // 047 · the whole read (incl. the join) runs inside the workspace-GUC transaction so the
  // RLS-subject client is DB-filtered; sequential to (not nested in) the getProjectRow txn above.
  const [rows] = await withWorkspaceRlsContext<[ProjectSourceBinding[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
    SELECT psb.id, psb.workspace_id, psb.project_id, psb.source_kind, psb.domain_id, psb.user_source_connection_id,
           psb.source_ref, psb.status, psb.read_policy, psb.connected_by, psb.connected_at,
           psb.last_verified_at, psb.reconnect_required_reason, psb.metadata,
           psb.created_at, psb.updated_at,
           CASE WHEN psb.source_kind = 'desktop_folder'
                THEN COALESCE(jsonb_array_length(COALESCE(fs.files, '[]'::jsonb)), 0) END AS folder_file_count,
           CASE WHEN psb.source_kind = 'desktop_folder' THEN fs.synced_at END AS folder_synced_at
    FROM project_source_bindings psb
    LEFT JOIN folder_snapshots fs ON fs.binding_id = psb.id
    WHERE psb.workspace_id = ${workspaceId}
      AND psb.project_id = ${projectId}
      AND psb.status <> 'archived'
    ORDER BY psb.created_at ASC, psb.id ASC
    LIMIT 100
  `,
  ], { readOnly: true });

  return rows.map(normalizeProjectSourceBindingRow);
}

export async function createProjectSourceBindingRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  input: ProjectSourceBindingInput,
  actorUserId: UserId,
): Promise<ProjectSourceBinding> {
  assertWorkspaceScope(workspaceId);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor_user_id is required', 400);
  validateProjectSourceBindingInput(input);

  const proj = await getProjectRow(sql, workspaceId, projectId);
  if (!proj) throw makeError('NOT_FOUND', `project ${projectId} not found in workspace ${workspaceId}`, 404);

  const id = `psb_${randomNanoid()}`;
  const status = input.status ?? 'pending_auth';
  const readPolicy = input.read_policy ?? 'metadata_only';
  const sourceRefJson = JSON.stringify(input.source_ref ?? {});
  const metadataJson = JSON.stringify(input.metadata ?? {});

  const rows = (await sql/*sql*/`
    INSERT INTO project_source_bindings (
      id, workspace_id, project_id, source_kind, domain_id, user_source_connection_id,
      source_ref, status, read_policy, connected_by, connected_at,
      last_verified_at, reconnect_required_reason, metadata, created_at, updated_at
    ) VALUES (
      ${id}, ${workspaceId}, ${projectId}, ${input.source_kind}, ${input.domain_id ?? null}, ${input.user_source_connection_id ?? null},
      ${sourceRefJson}::jsonb, ${status}, ${readPolicy}, ${actorUserId},
      CASE WHEN ${status} = 'connected' THEN now() ELSE NULL END,
      CASE WHEN ${status} = 'connected' THEN now() ELSE NULL END,
      ${input.reconnect_required_reason ?? null},
      ${metadataJson}::jsonb, now(), now()
    )
    RETURNING id, workspace_id, project_id, source_kind, domain_id, user_source_connection_id,
              source_ref, status, read_policy, connected_by, connected_at,
              last_verified_at, reconnect_required_reason, metadata,
              created_at, updated_at
  `) as ProjectSourceBinding[];

  const row = rows[0];
  if (!row) throw makeError('INTERNAL_ERROR', 'project source binding insert returned no row', 500);

  try {
    await sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      VALUES (${actorUserId}, 'project_source_binding_create', 'project_source_binding', ${id}, ${workspaceId},
              ${`project=${projectId} · kind=${input.source_kind} · read_policy=${readPolicy}`})
    `;
  } catch (e) { void e; }

  return normalizeProjectSourceBindingRow(row);
}

// ── ARCH-006 W2.1 (D2) · github → source binding backfill ───────────────────
// The data-graph's `source` node + `feeds` edge were DEAD (prod census: source=0) because 99.8% of
// events are github-webhook-sourced and the webhook writes operation_events directly, creating NO
// project_source_bindings row. This ensures a github_repo binding for every (workspace, project, repo)
// the operator's github events reference — so `source → feeds → project` becomes real. It is:
//   - operator-scoped (owner_user_id = ANY(ids)) — never touches a customer tenant;
//   - FK-safe (JOIN projects — only binds project_ids that exist, so the NOT NULL FK can't fail);
//   - idempotent (deterministic id + NOT EXISTS on the active source_ref + ON CONFLICT DO NOTHING);
//   - covers HISTORICAL events (backfill) AND new ones (the hourly graph-rebuild cron re-runs it).
// The repo is parsed from the event summary's `[owner/repo]` / `[owner/repo#N]` prefix without regex.
export async function ensureGithubRepoBindingsForOperatorRow(sql: Sql, ownerUserIds: UserId[]): Promise<number> {
  const ids = (ownerUserIds || []).filter(Boolean);
  if (ids.length === 0) return 0;
  const rows = (await sql/*sql*/`
    INSERT INTO project_source_bindings
      (id, workspace_id, project_id, source_kind, source_ref, status, read_policy,
       connected_by, connected_at, last_verified_at, metadata, created_at, updated_at)
    SELECT
      'psb_gh_' || substr(md5(d.workspace_id || '|' || d.project_id || '|' || d.repo), 1, 26),
      d.workspace_id, d.project_id, 'github_repo',
      jsonb_build_object('full_name', d.repo, 'repo', d.repo),
      'connected', 'metadata_only', 'github:webhook', now(), now(),
      jsonb_build_object('connector', 'github', 'origin', 'backfill'),
      now(), now()
    FROM (
      SELECT DISTINCT oe.workspace_id, oe.project_id,
        split_part(split_part(substring(oe.summary from 2), ']', 1), '#', 1) AS repo
      FROM operation_events oe
      JOIN workspaces w ON w.id = oe.workspace_id
      JOIN projects p ON p.id = oe.project_id AND p.workspace_id = oe.workspace_id
      WHERE w.owner_user_id = ANY(${ids})
        AND oe.source_tool = 'github'
        AND oe.project_id IS NOT NULL
        AND oe.summary LIKE '[%'
    ) d
    WHERE d.repo IS NOT NULL AND d.repo <> '' AND position('/' in d.repo) > 0
      AND NOT EXISTS (
        SELECT 1 FROM project_source_bindings b
        WHERE b.project_id = d.project_id AND b.source_kind = 'github_repo'
          AND b.source_ref->>'full_name' = d.repo AND b.status <> 'archived'
      )
    ON CONFLICT DO NOTHING
    RETURNING id
  `) as Array<{ id: string }>;
  return Array.isArray(rows) ? rows.length : 0;
}

export async function updateProjectSourceBindingRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  bindingId: string,
  patch: ProjectSourceBindingPatch,
  actorUserId: UserId,
): Promise<ProjectSourceBinding | null> {
  assertWorkspaceScope(workspaceId);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);
  if (!bindingId) throw makeError('VALIDATION_ERROR', 'binding_id is required', 400);
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor_user_id is required', 400);
  validateProjectSourceBindingPatch(patch);

  const proj = await getProjectRow(sql, workspaceId, projectId);
  if (!proj) throw makeError('NOT_FOUND', `project ${projectId} not found in workspace ${workspaceId}`, 404);

  const sourceRefJson = patch.source_ref === undefined ? null : JSON.stringify(patch.source_ref);
  const metadataJson = patch.metadata === undefined ? null : JSON.stringify(patch.metadata);
  const status = patch.status ?? null;
  const readPolicy = patch.read_policy ?? null;

  const rows = (await sql/*sql*/`
    UPDATE project_source_bindings
       SET source_ref = COALESCE(${sourceRefJson}::jsonb, source_ref),
           status = COALESCE(${status}, status),
           read_policy = COALESCE(${readPolicy}, read_policy),
           reconnect_required_reason = COALESCE(${patch.reconnect_required_reason ?? null}, reconnect_required_reason),
           metadata = COALESCE(${metadataJson}::jsonb, metadata),
           connected_by = CASE WHEN ${status} = 'connected' THEN ${actorUserId} ELSE connected_by END,
           connected_at = CASE WHEN ${status} = 'connected' THEN COALESCE(connected_at, now()) ELSE connected_at END,
           last_verified_at = CASE WHEN ${status} = 'connected' THEN now() ELSE last_verified_at END,
           updated_at = now()
     WHERE id = ${bindingId}
       AND workspace_id = ${workspaceId}
       AND project_id = ${projectId}
     RETURNING id, workspace_id, project_id, source_kind, user_source_connection_id,
               source_ref, status, read_policy, connected_by, connected_at,
               last_verified_at, reconnect_required_reason, metadata,
               created_at, updated_at
  `) as ProjectSourceBinding[];

  if (rows.length === 0) return null;
  return normalizeProjectSourceBindingRow(rows[0]!);
}

export async function archiveProjectSourceBindingRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  bindingId: string,
  actorUserId: UserId,
): Promise<ProjectSourceBinding | null> {
  return updateProjectSourceBindingRow(
    sql,
    workspaceId,
    projectId,
    bindingId,
    { status: 'archived', reconnect_required_reason: 'archived_by_operator' },
    actorUserId,
  );
}
