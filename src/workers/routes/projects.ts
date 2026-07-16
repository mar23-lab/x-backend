// projects.ts · /api/v1/projects routes
//
// Authority: API_CONTRACT_V1.md §GET /api/v1/projects
// R45 (2026-05-28): adds GET /projects/:id · PATCH /projects/:id/scope ·
// GET /projects/:id/events for scope_binding management.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { withAuthority } from '../lib/allowed-actions';
import { lineageFor } from '../lib/actor-lineage';
import { inferSourceContext } from '../lib/infer-source-context';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type {
  ProjectStatus,
  ProjectListOpts,
  ProjectScopeBinding,
  EventListOpts,
  ProjectCreateInput,
  ProjectSourceBindingInput,
  ProjectSourceBindingPatch,
  ProjectSourceKind,
  OAuthProvider,
} from '../dal/types';

export interface ProjectsEnv extends AuthEnv {
  DATABASE_URL: string;
}

export interface ProjectsVariables extends AuthVariables {
  dal: DalAdapter;
}

export const projectsRoute = new Hono<{ Bindings: ProjectsEnv; Variables: ProjectsVariables }>();

const VALID_STATUSES: ReadonlySet<ProjectStatus> = new Set([
  'active', 'paused', 'completed', 'archived',
]);
const PROJECT_SOURCE_KINDS: ReadonlySet<ProjectSourceKind> = new Set([
  'github_repo', 'google_drive_folder', 'desktop_folder', 'manual',
]);
const PROJECT_SOURCE_STATUSES = new Set([
  'pending_auth', 'connected', 'reconnect_required', 'disabled_preview', 'archived',
]);
const PROJECT_SOURCE_READ_POLICIES = new Set([
  'metadata_only', 'proposal_only', 'read_only',
]);
const SOURCE_KIND_TO_PROVIDER: Partial<Record<ProjectSourceKind, OAuthProvider>> = {
  github_repo: 'github',
  google_drive_folder: 'google_drive',
};

projectsRoute.get('/projects', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, role } = auth;
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({
        error: 'client role cannot list projects',
        code: 'FORBIDDEN',
        request_id: ctx.get('request_id'),
      });
    }

    const url = new URL(ctx.req.url);
    const status = (url.searchParams.get('status') || 'active') as ProjectStatus;

    if (!VALID_STATUSES.has(status)) {
      ctx.status(400);
      return ctx.json({
        error: `invalid status: ${status}`,
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }

    const opts: ProjectListOpts = { status };
    const dal = ctx.get('dal');
    const projects = await dal.listProjects(workspace_id, opts);
    return ctx.json(withDataClass(withAuthority({ projects }, auth, 'project'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// R45 · single-project read · scope-binding management · scoped events
// ============================================================

// R53-W4.x · resolve the workspace a per-project op should address. The VERIFIED
// platform owner can own a project living in a workspace that is NOT their JWT org
// (mbp-private, x-docs); the strict workspace-scoped DAL calls below 404 such a
// project — the bug behind the scope-binding panel's "project <id> not found"
// diagnostic + the empty per-project view (mbp-life lives in mbp-private, not the
// JWT org). For the primary owner ONLY (user_id === MBP_OWNER_USER_ID), resolve the
// project's REAL workspace via the operator identity set (its OWN workspaces,
// resolved INSIDE the DAL). Non-owners + a not-found overlay fall through to the JWT
// workspace unchanged — no behaviour change for any other caller. Mirrors the
// established GET /events + GET /provenance operator overlays.
async function resolveOperatorProjectWorkspace(
  ctx: { env: unknown },
  dal: unknown,
  projectId: string,
  jwtWorkspaceId: string,
  userId: string | undefined,
): Promise<string> {
  const ownerUserId = String((ctx.env as { MBP_OWNER_USER_ID?: string })?.MBP_OWNER_USER_ID || '').trim();
  if (!ownerUserId || !userId || userId !== ownerUserId) return jwtWorkspaceId;
  if (typeof (dal as { getProjectForOperator?: unknown }).getProjectForOperator !== 'function') return jwtWorkspaceId;
  const linkedIds = String((ctx.env as { MBP_OWNER_LINKED_USER_IDS?: string })?.MBP_OWNER_LINKED_USER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const op = await (dal as {
    getProjectForOperator: (ids: string[], p: string) => Promise<{ workspace_id?: string } | null>;
  }).getProjectForOperator([ownerUserId, ...linkedIds], projectId);
  return (op && op.workspace_id) ? op.workspace_id : jwtWorkspaceId;
}

const SCOPE_FILTER_TYPES = new Set(['actor_in', 'source_tool_in', 'status_in', 'visibility_in']);

/** Validate a scope_binding payload (route layer; mirrored in DAL). */
function validateScopeBinding(input: unknown): ProjectScopeBinding | null | string {
  if (input === null) return null;
  if (typeof input !== 'object') return 'scope_binding must be an object or null';
  const b = input as Record<string, unknown>;
  if (b.version !== 1) return 'scope_binding.version must be 1';
  if (b.combine !== 'all' && b.combine !== 'any') return 'scope_binding.combine must be "all" or "any"';
  if (!Array.isArray(b.filters)) return 'scope_binding.filters must be an array';
  if (b.filters.length > 20) return 'scope_binding.filters max length is 20';
  for (let i = 0; i < b.filters.length; i++) {
    const f = b.filters[i] as Record<string, unknown>;
    if (!f || typeof f !== 'object') return `filters[${i}] must be an object`;
    if (typeof f.type !== 'string' || !SCOPE_FILTER_TYPES.has(f.type)) {
      return `filters[${i}].type must be one of: ${[...SCOPE_FILTER_TYPES].join(', ')}`;
    }
    if (!Array.isArray(f.values) || f.values.length === 0) {
      return `filters[${i}].values must be a non-empty array`;
    }
    if (f.values.length > 50) {
      return `filters[${i}].values max length is 50`;
    }
    for (const v of f.values) {
      if (typeof v !== 'string' || v.length === 0 || v.length > 200) {
        return `filters[${i}] values must be non-empty strings up to 200 chars`;
      }
    }
  }
  return input as ProjectScopeBinding;
}

function validateProjectSourceInput(input: unknown): ProjectSourceBindingInput | string {
  if (!input || typeof input !== 'object') return 'request body must be a JSON object';
  const body = input as Record<string, unknown>;
  if (typeof body.source_kind !== 'string' || !PROJECT_SOURCE_KINDS.has(body.source_kind as ProjectSourceKind)) {
    return `source_kind must be one of: ${[...PROJECT_SOURCE_KINDS].join(', ')}`;
  }
  if (body.status !== undefined && (typeof body.status !== 'string' || !PROJECT_SOURCE_STATUSES.has(body.status))) {
    return `status must be one of: ${[...PROJECT_SOURCE_STATUSES].join(', ')}`;
  }
  if (body.read_policy !== undefined && (typeof body.read_policy !== 'string' || !PROJECT_SOURCE_READ_POLICIES.has(body.read_policy))) {
    return `read_policy must be one of: ${[...PROJECT_SOURCE_READ_POLICIES].join(', ')}`;
  }
  if (body.source_ref !== undefined && (!body.source_ref || typeof body.source_ref !== 'object' || Array.isArray(body.source_ref))) {
    return 'source_ref must be an object';
  }
  if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata))) {
    return 'metadata must be an object';
  }
  if (body.user_source_connection_id !== undefined && body.user_source_connection_id !== null && typeof body.user_source_connection_id !== 'string') {
    return 'user_source_connection_id must be a string or null';
  }
  // W1'-PR4 · optional domain_id: attach this source to a synthetic_domains lens.
  if (body.domain_id !== undefined && body.domain_id !== null && (typeof body.domain_id !== 'string' || body.domain_id.length === 0 || body.domain_id.length > 128)) {
    return 'domain_id must be a non-empty string (≤128 chars) or null';
  }
  return {
    source_kind: body.source_kind as ProjectSourceKind,
    domain_id: typeof body.domain_id === 'string' ? body.domain_id : null,
    user_source_connection_id: typeof body.user_source_connection_id === 'string' ? body.user_source_connection_id : null,
    source_ref: (body.source_ref && typeof body.source_ref === 'object' && !Array.isArray(body.source_ref)) ? body.source_ref as Record<string, unknown> : {},
    status: typeof body.status === 'string' ? body.status as ProjectSourceBindingInput['status'] : undefined,
    read_policy: typeof body.read_policy === 'string' ? body.read_policy as ProjectSourceBindingInput['read_policy'] : 'metadata_only',
    reconnect_required_reason: typeof body.reconnect_required_reason === 'string' ? body.reconnect_required_reason : null,
    metadata: (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) ? body.metadata as Record<string, unknown> : {},
  };
}

function validateProjectSourcePatch(input: unknown): ProjectSourceBindingPatch | string {
  if (!input || typeof input !== 'object') return 'request body must be a JSON object';
  const body = input as Record<string, unknown>;
  if (body.status !== undefined && (typeof body.status !== 'string' || !PROJECT_SOURCE_STATUSES.has(body.status))) {
    return `status must be one of: ${[...PROJECT_SOURCE_STATUSES].join(', ')}`;
  }
  if (body.read_policy !== undefined && (typeof body.read_policy !== 'string' || !PROJECT_SOURCE_READ_POLICIES.has(body.read_policy))) {
    return `read_policy must be one of: ${[...PROJECT_SOURCE_READ_POLICIES].join(', ')}`;
  }
  if (body.source_ref !== undefined && (!body.source_ref || typeof body.source_ref !== 'object' || Array.isArray(body.source_ref))) {
    return 'source_ref must be an object';
  }
  if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata))) {
    return 'metadata must be an object';
  }
  return {
    source_ref: body.source_ref as ProjectSourceBindingPatch['source_ref'],
    status: body.status as ProjectSourceBindingPatch['status'],
    read_policy: body.read_policy as ProjectSourceBindingPatch['read_policy'],
    reconnect_required_reason: typeof body.reconnect_required_reason === 'string' ? body.reconnect_required_reason : undefined,
    metadata: body.metadata as ProjectSourceBindingPatch['metadata'],
  };
}

projectsRoute.get('/projects/:id', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, role, user_id } = auth;
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read projects', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const projectId = ctx.req.param('id');
    if (!projectId) {
      ctx.status(400);
      return ctx.json({ error: 'project id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const ws = await resolveOperatorProjectWorkspace(ctx, dal, projectId, workspace_id, user_id);
    const project = await dal.getProject(ws, projectId);
    if (!project) {
      ctx.status(404);
      return ctx.json({ error: `project ${projectId} not found`, code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    return ctx.json(withDataClass(withAuthority({ project }, auth, 'project'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

projectsRoute.patch('/projects/:id/scope', async (ctx) => {
  try {
    const { workspace_id, role, user_id } = ctx.get('auth');
    // Only owner + operator may set scope binding (clients/members cannot).
    if (role !== 'owner' && role !== 'operator') {
      ctx.status(403);
      return ctx.json({
        error: `role ${role} cannot update scope_binding (requires owner or operator)`,
        code: 'FORBIDDEN',
        request_id: ctx.get('request_id'),
      });
    }
    const projectId = ctx.req.param('id');
    if (!projectId) {
      ctx.status(400);
      return ctx.json({ error: 'project id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as { scope_binding?: unknown } | null;
    if (!body || !('scope_binding' in body)) {
      ctx.status(400);
      return ctx.json({
        error: 'body must include scope_binding (set to null to clear)',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    const validated = validateScopeBinding(body.scope_binding);
    if (typeof validated === 'string') {
      ctx.status(400);
      return ctx.json({ error: validated, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const ws = await resolveOperatorProjectWorkspace(ctx, dal, projectId, workspace_id, user_id);
    const project = await dal.updateProjectScope(ws, projectId, validated, user_id);
    return ctx.json({ project });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// R55-L3 · PATCH /api/v1/projects/:id · rename / edit (owner + operator only).
// The "Projects are next" half of the operator lifecycle ask: rename a project +
// edit its description/status. Mirrors the workspace PATCH gate. Soft-archive is
// the sibling DELETE below.
projectsRoute.patch('/projects/:id', async (ctx) => {
  try {
    const { workspace_id, role, user_id } = ctx.get('auth');
    if (role !== 'owner' && role !== 'operator') {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot edit projects (requires owner or operator)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const projectId = ctx.req.param('id');
    if (!projectId) {
      ctx.status(400);
      return ctx.json({ error: 'project id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as { name?: unknown; description?: unknown; status?: unknown } | null;
    if (!body || typeof body !== 'object') {
      ctx.status(400);
      return ctx.json({ error: 'request body must be a JSON object', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const name = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim() : undefined;
    const description = (typeof body.description === 'string') ? body.description : undefined;
    const status = (typeof body.status === 'string') ? body.status as ProjectStatus : undefined;
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      ctx.status(400);
      return ctx.json({ error: `invalid status: ${status}`, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    if (name === undefined && description === undefined && status === undefined) {
      ctx.status(400);
      return ctx.json({ error: 'nothing to update (provide name, description, and/or status)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const ws = await resolveOperatorProjectWorkspace(ctx, dal, projectId, workspace_id, user_id);
    const project = await dal.updateProject(ws, projectId, { name, description, status }, user_id);
    if (!project) {
      ctx.status(404);
      return ctx.json({ error: `project ${projectId} not found`, code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    return ctx.json({ project });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// R55-L3 · DELETE /api/v1/projects/:id · soft-archive (owner + operator only).
// REVERSIBLE: sets status='archived' (no destructive row delete), mirroring the
// workspace soft-archive ethos — listProjects(status:'active') then excludes it,
// and it can be restored with PATCH status='active'.
projectsRoute.delete('/projects/:id', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, role, user_id } = auth;
    if (role !== 'owner' && role !== 'operator') {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot remove projects (requires owner or operator)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const projectId = ctx.req.param('id');
    if (!projectId) {
      ctx.status(400);
      return ctx.json({ error: 'project id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const ws = await resolveOperatorProjectWorkspace(ctx, dal, projectId, workspace_id, user_id);
    const project = await dal.updateProject(ws, projectId, { status: 'archived' }, user_id);
    if (!project) {
      ctx.status(404);
      return ctx.json({ error: `project ${projectId} not found`, code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    // Recoverability doctrine (260706, ARCH-006 W1.2 tiered-provenance pattern): destructive ops
    // MUST be visible on the customer-facing operation_events spine, not only in audit_logs —
    // otherwise a customer cannot see that their project was archived. Best-effort + idempotent:
    // never block the archive; log on failure (audit loss must be visible, not silent).
    try {
      await dal.upsertEvent(ws, {
        id: `evt_project_archive_${projectId}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
        source_tool: 'xlooop',
        agent_id: 'xlooop:operator-action',
        project_id: projectId,
        status: 'completed',
        summary: `[project archived] ${String(project.name || projectId)}`.slice(0, 512),
        body: 'Soft-archive (reversible): restore with PATCH status=active.',
        visibility: 'internal_workspace',
        occurred_at: new Date().toISOString(),
        // A-W4/P6 · destructive-op lineage: the archiving human is principal + instrument (role authority).
        ...lineageFor(auth),
        request_id: ctx.get('request_id'),
      });
    } catch (err) {
      console.warn('[projects] project-archive event mirror failed (best-effort)', { workspace_id: ws, error: (err as Error)?.message });
    }
    return ctx.json({ ok: true, archived: true, project });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

projectsRoute.get('/projects/:id/sources', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, role, user_id } = auth;
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read project sources', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const projectId = ctx.req.param('id');
    if (!projectId) {
      ctx.status(400);
      return ctx.json({ error: 'project id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    // 260706 correspondence fix · a `domain:` id is a cross-project DOMAIN LENS (a rollup surfaced in
    // the rail — e.g. MB-P life-domains `domain:mb-p:health`), NOT a project. A lens owns no direct
    // source bindings, so return an empty set gracefully instead of 404-ing the frontend's fetch.
    if (projectId.startsWith('domain:')) {
      return ctx.json(withDataClass(withAuthority({ sources: [] }, auth, 'project_source'), 'live'));
    }
    const dal = ctx.get('dal');
    const ws = await resolveOperatorProjectWorkspace(ctx, dal, projectId, workspace_id, user_id);
    const sources = await dal.listProjectSourceBindings(ws, projectId);
    return ctx.json(withDataClass(withAuthority({ sources }, auth, 'project_source'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

projectsRoute.post('/projects/:id/sources', async (ctx) => {
  try {
    const { workspace_id, role, user_id } = ctx.get('auth');
    if (role !== 'owner' && role !== 'operator') {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot bind project sources (requires owner or operator)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const projectId = ctx.req.param('id');
    if (!projectId) {
      ctx.status(400);
      return ctx.json({ error: 'project id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null);
    const input = validateProjectSourceInput(body);
    if (typeof input === 'string') {
      ctx.status(400);
      return ctx.json({ error: input, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }

    const dal = ctx.get('dal');
    const ws = await resolveOperatorProjectWorkspace(ctx, dal, projectId, workspace_id, user_id);
    const provider = SOURCE_KIND_TO_PROVIDER[input.source_kind];
    if (provider && input.user_source_connection_id) {
      const userSource = await dal.getUserSource(user_id, input.user_source_connection_id);
      if (!userSource) {
        ctx.status(404);
        return ctx.json({ error: 'user source connection not found for this user', code: 'NOT_FOUND', request_id: ctx.get('request_id') });
      }
      if (userSource.provider !== provider) {
        ctx.status(400);
        return ctx.json({ error: `source_kind ${input.source_kind} requires ${provider} user source`, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
      }
      if (!userSource.workspace_id) {
        ctx.status(409);
        return ctx.json({
          error: 'source connection must be explicitly bound to this workspace before it can be attached to a project',
          code: 'SOURCE_WORKSPACE_BINDING_REQUIRED',
          request_id: ctx.get('request_id'),
        });
      }
      if (userSource.workspace_id !== ws) {
        ctx.status(403);
        return ctx.json({
          error: 'source connection belongs to a different workspace',
          code: 'SOURCE_WORKSPACE_MISMATCH',
          request_id: ctx.get('request_id'),
        });
      }
    }
    if (!provider && input.user_source_connection_id) {
      ctx.status(400);
      return ctx.json({ error: `${input.source_kind} must not reference a Clerk OAuth source connection`, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    if (provider && input.status === 'connected' && !input.user_source_connection_id) {
      ctx.status(400);
      return ctx.json({ error: 'connected OAuth project source requires user_source_connection_id', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }

    const source = await dal.createProjectSourceBinding(ws, projectId, input, user_id);
    // R1 — auto-link by context: PROPOSE a domain hint + tags from the source (propose-then-confirm).
    // Pure inference; nothing is tagged or created until the operator/customer confirms.
    const suggested_context = inferSourceContext({ source_kind: input.source_kind, source_ref: input.source_ref });
    // ARCH-006 W1.2 — tiered provenance: record connect-a-source as a first-class OPERATION-tier event
    // so the chief-of-staff sees the operator's own action (not just github commits). Carries project_id
    // so it also feeds the lineage graph (source → project). Best-effort + idempotent: never block the bind.
    try {
      const ref = (input.source_ref || {}) as Record<string, unknown>;
      const refLabel = String(ref.label || ref.repo || ref.full_name || ref.path || '').slice(0, 200);
      await dal.upsertEvent(ws, {
        id: `evt_source_connect_${source.id}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
        source_tool: 'xlooop',
        agent_id: 'xlooop:operator-action',
        project_id: projectId,
        status: input.status === 'connected' ? 'completed' : 'needs_review',
        summary: `[source connected] ${input.source_kind}${refLabel ? ' · ' + refLabel : ''}`.slice(0, 512),
        visibility: 'internal_workspace',
        occurred_at: new Date().toISOString(),
      });
    } catch (err) {
      // best-effort operator-action mirror — never block the bind, but LOG it (audit loss must be visible, not silent).
      console.warn('[projects] source-connect audit mirror failed (best-effort)', { workspace_id: ws, error: (err as Error)?.message });
    }
    ctx.status(201);
    return ctx.json({ source, suggested_context });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

projectsRoute.patch('/projects/:id/sources/:bindingId', async (ctx) => {
  try {
    const { workspace_id, role, user_id } = ctx.get('auth');
    if (role !== 'owner' && role !== 'operator') {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot update project sources (requires owner or operator)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const projectId = ctx.req.param('id');
    const bindingId = ctx.req.param('bindingId');
    if (!projectId || !bindingId) {
      ctx.status(400);
      return ctx.json({ error: 'project id and binding id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null);
    const patch = validateProjectSourcePatch(body);
    if (typeof patch === 'string') {
      ctx.status(400);
      return ctx.json({ error: patch, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const source = await dal.updateProjectSourceBinding(workspace_id, projectId, bindingId, patch, user_id);
    if (!source) {
      ctx.status(404);
      return ctx.json({ error: `project source binding ${bindingId} not found`, code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    return ctx.json({ source });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

projectsRoute.delete('/projects/:id/sources/:bindingId', async (ctx) => {
  try {
    const { workspace_id, role, user_id } = ctx.get('auth');
    if (role !== 'owner' && role !== 'operator') {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot archive project sources (requires owner or operator)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const projectId = ctx.req.param('id');
    const bindingId = ctx.req.param('bindingId');
    if (!projectId || !bindingId) {
      ctx.status(400);
      return ctx.json({ error: 'project id and binding id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const source = await dal.archiveProjectSourceBinding(workspace_id, projectId, bindingId, user_id);
    if (!source) {
      ctx.status(404);
      return ctx.json({ error: `project source binding ${bindingId} not found`, code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    // Recoverability doctrine (260706): mirror the archive onto the customer-visible event spine
    // (counterpart of the [source connected] event above). Best-effort — never block the archive.
    try {
      const ref = (source.source_ref || {}) as Record<string, unknown>;
      const refLabel = String(ref.label || ref.repo || ref.full_name || ref.path || '').slice(0, 200);
      await dal.upsertEvent(workspace_id, {
        id: `evt_source_archive_${bindingId}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
        source_tool: 'xlooop',
        agent_id: 'xlooop:operator-action',
        project_id: projectId,
        status: 'completed',
        summary: `[project source archived] ${String(source.source_kind || 'source')}${refLabel ? ' · ' + refLabel : ''}`.slice(0, 512),
        body: 'Soft-archive (reversible): restore with PATCH status=connected.',
        visibility: 'internal_workspace',
        occurred_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[projects] source-archive event mirror failed (best-effort)', { workspace_id, error: (err as Error)?.message });
    }
    return ctx.json({ ok: true, archived: true, source });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

projectsRoute.get('/projects/:id/events', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, role, user_id } = auth;
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read project events', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const projectId = ctx.req.param('id');
    if (!projectId) {
      ctx.status(400);
      return ctx.json({ error: 'project id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const url = new URL(ctx.req.url);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.max(1, Math.min(parseInt(limitParam, 10) || 100, 200)) : 100;
    const opts: EventListOpts = { limit, role };
    const dal = ctx.get('dal');

    // R53-W4 (Phase 1) · operator overlay. Mirror of the GET /provenance and GET
    // /events overlays. A project the operator OWNS can live in a workspace that is
    // NOT their active Clerk org (e.g. x-docs, mbp-private). The strict path below
    // scopes to the JWT workspace, so that owned project's events return empty (or
    // the project 404s) even though the operator owns it — the gate that blocks the
    // per-project cockpit view. For the VERIFIED platform owner only, list events
    // by the operator IDENTITY SET (their OWN workspaces, resolved INSIDE the DAL),
    // filtered to this project_id. listEventsForOperator scopes to workspaces where
    // owner_user_id ∈ operator ids, so an owned project in a non-active workspace
    // resolves here WITHOUT a workspace-scoped getProjectRow lookup — no 404. Every
    // other caller keeps the strict workspace-scoped path below — no behaviour
    // change. ACCESS is gated on the primary owner (user_id === ownerUserId); the
    // linked ids only EXPAND scope, never grant entry.
    const ownerUserId = String((ctx.env as { MBP_OWNER_USER_ID?: string })?.MBP_OWNER_USER_ID || '').trim();
    if (ownerUserId && user_id && user_id === ownerUserId
        && typeof (dal as { listEventsForOperator?: unknown }).listEventsForOperator === 'function') {
      const linkedIds = String((ctx.env as { MBP_OWNER_LINKED_USER_IDS?: string })?.MBP_OWNER_LINKED_USER_IDS || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const page = await (dal as unknown as {
        listEventsForOperator: (ids: string[], o: EventListOpts) => Promise<unknown>;
      }).listEventsForOperator([ownerUserId, ...linkedIds], { ...opts, project_id: projectId });
      // A-W2e · attach the same server-derived M3/M4 envelope the flat GET /events carries, so the
      // per-project events feeding the cockpit rails also gate their governed controls server-side.
      return ctx.json(withDataClass(withAuthority(page as Record<string, unknown>, auth, 'event'), 'live'));
    }

    const page = await dal.listEventsForProjectScope(workspace_id, projectId, opts);
    return ctx.json(withDataClass(withAuthority(page as unknown as Record<string, unknown>, auth, 'event'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// R52-A1 · GET /api/v1/projects/:id/provenance · which sources fed this project
// Powers provenance chips on project cards (pillar 2). Returns per-source
// event counts + last-event time + is_oauth_source flag.
projectsRoute.get('/projects/:id/provenance', async (ctx) => {
  try {
    const { workspace_id, role, user_id } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read project provenance', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const projectId = ctx.req.param('id');
    if (!projectId) {
      ctx.status(400);
      return ctx.json({ error: 'project id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');

    // R53-W4 · operator overlay. The operator's cockpit shows governance projects
    // (xlooop-product, mbp-ops…) whose live events accrue by scope_binding FILTER
    // and live in the operator's own Clerk org — NOT in their JWT workspace. For
    // the VERIFIED platform owner only, compute provenance by scope_binding,
    // tenant-scoped (inside the DAL) to the operator's OWN workspaces. Every other
    // caller keeps the strict workspace-scoped path below — no behaviour change.
    const ownerUserId = String((ctx.env as { MBP_OWNER_USER_ID?: string })?.MBP_OWNER_USER_ID || '').trim();
    // R53-W4.1 · the operator may sign in under more than one Clerk id (a
    // governance identity + an org identity that are BOTH them).
    // MBP_OWNER_LINKED_USER_IDS (comma-separated) lists the other ids belonging
    // to the SAME operator, so events in their other org(s) surface here too.
    // ACCESS is still gated on the primary owner (user_id === ownerUserId); the
    // linked ids only EXPAND the provenance scope, never grant entry.
    const linkedIds = String((ctx.env as { MBP_OWNER_LINKED_USER_IDS?: string })?.MBP_OWNER_LINKED_USER_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const operatorIds = [ownerUserId, ...linkedIds].filter(Boolean);
    if (ownerUserId && user_id && user_id === ownerUserId
        && typeof (dal as { getProjectProvenanceForOperator?: unknown }).getProjectProvenanceForOperator === 'function') {
      const provenance = await (dal as unknown as {
        getProjectProvenanceForOperator: (ids: string[], p: string) => Promise<unknown>;
      }).getProjectProvenanceForOperator(operatorIds, projectId);
      return ctx.json(provenance as Record<string, unknown>);
    }

    const provenance = await dal.getProjectProvenance(workspace_id, projectId);
    return ctx.json(provenance);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// R47.3 · POST /api/v1/projects · create a domain or sub-domain (owner/operator only)
projectsRoute.post('/projects', async (ctx) => {
  try {
    const { workspace_id, role, user_id } = ctx.get('auth');
    if (role !== 'owner' && role !== 'operator') {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot create projects (requires owner or operator)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as Partial<ProjectCreateInput> | null;
    if (!body || typeof body.name !== 'string' || body.name.length === 0) {
      ctx.status(400);
      return ctx.json({ error: 'body.name required (1-200 chars)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    if (body.workspace_id && body.workspace_id !== workspace_id) {
      ctx.status(403);
      return ctx.json({ error: 'cannot create projects in another workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    if (body.status && !VALID_STATUSES.has(body.status as ProjectStatus)) {
      ctx.status(400);
      return ctx.json({ error: `invalid status: ${body.status}`, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const input: ProjectCreateInput = {
      id: body.id,
      workspace_id: workspace_id,
      name: body.name,
      status: (body.status as ProjectStatus) ?? 'active',
      description: body.description,
      metadata: body.metadata,
      parent_project_id: body.parent_project_id ?? null,
    };
    const dal = ctx.get('dal');
    const project = await dal.createProject(input, user_id);
    return ctx.json({ project });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// R47.3 · GET /api/v1/projects/:id/children · list direct children of a project
projectsRoute.get('/projects/:id/children', async (ctx) => {
  try {
    const { workspace_id, role } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read projects', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const parentId = ctx.req.param('id');
    if (!parentId) {
      ctx.status(400);
      return ctx.json({ error: 'project id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const projects = await dal.listChildProjects(workspace_id, parentId);
    return ctx.json(withDataClass({ projects }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
