// synthetic-domains.ts · /api/v1/synthetic-domains routes
//
// Authority: docs/_archive/audits/260528-r49-lem-v3-plan/LEM_V3_ARCHITECTURE.md
// R49' (2026-05-28): LEM-v3 PR-1 · synthetic_domains entity + 7 endpoints.
//
// Endpoints (all require JWT + workspace via clerkAuth):
//   POST   /synthetic-domains                          · create (owner/operator)
//   GET    /synthetic-domains?workspace_id=...         · list workspace-scoped
//   GET    /synthetic-domains?workspace_id=__cross__   · list cross-workspace (operator-only)
//   GET    /synthetic-domains/:id                      · get one
//   PATCH  /synthetic-domains/:id/binding              · update binding (owner/operator)
//   PATCH  /synthetic-domains/:id/archive              · archive
//   POST   /synthetic-domains/:id/refresh-membership   · recompute membership
//   GET    /synthetic-domains/:id/members              · list member projects

import { Hono } from 'hono';
import { isOperatorContext, isMbpOperator, operatorIds } from '../lib/permissions';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { withAuthority } from '../lib/allowed-actions';
import { observePolicyShadow } from '../lib/policy-shadow';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type {
  SyntheticDomain,
  SyntheticDomainCreateInput,
  SyntheticDomainBinding,
  SyntheticDomainStatus,
  SyntheticDomainRoadmapCreateInput,
  SyntheticDomainRoadmapItemInput,
  SyntheticDomainGoalCreateInput,
  RoadmapStatus,
  RoadmapItemStatus,
  GoalStatus,
  PropagationRuleCreateInput,
  PropagationRuleStatus,
  RecommendationStatus,
} from '../dal/types';

export interface SyntheticDomainsEnv extends AuthEnv {
  DATABASE_URL: string;
  // MB-P operator identity — lets the orgless (personal Clerk session) operator be
  // recognized by STABLE user_id, mirroring routes/workspaces.ts operatorIds(). The
  // default operator has no Clerk org, so org-role checks alone never recognize them.
  MBP_OWNER_USER_ID?: string;
  MBP_OWNER_LINKED_USER_IDS?: string;
}

export interface SyntheticDomainsVariables extends AuthVariables {
  dal: DalAdapter;
}

export const syntheticDomainsRoute = new Hono<{ Bindings: SyntheticDomainsEnv; Variables: SyntheticDomainsVariables }>();

// isOperatorContext/isMbpOperator: consolidated into lib/permissions.ts (S3, 260709) — one driver.

// ── HR-IP-BOUNDARY-1 · tenant-safe synthetic-domain projection ──────────────
// A synthetic domain is a LENS the operator constructs over the tenant fleet; its
// CONSTRUCTION IP — the binding FILTERS, the source-domain lineage, and the
// derivation fingerprint/version/mutation policy — must never reach a tenant. The
// tenant is entitled only to the lens's label, membership signals, and visibility.
//
// We FAIL CLOSED via an ALLOW-LIST: the set below enumerates the ONLY fields a
// non-operator may receive; any field NOT on it — including any field added to
// SyntheticDomain in the future — is stripped by default, so a later schema change
// cannot silently re-open the leak. Operators (isOperator === true) receive the
// full row unchanged, so the operator console keeps every field it renders today.
//
// The four fields the verified leak named — source_domains, derivation_fingerprint,
// derivation_version, derivative_mutation_allowed — are a SUBSET of what the
// allow-list omits (binding + operator-internal authorship fields are dropped too).
const TENANT_SAFE_SYNTHETIC_DOMAIN_FIELDS: ReadonlyArray<keyof SyntheticDomain> = [
  'id',
  'workspace_id',
  'slug',
  'label',
  'description',
  'visibility',
  'status',
  'has_roadmap',
  'goal_count',
  'open_recommendation_count',
  'metadata',
  // R1 — `kind` (life|company|work|custom) is a tenant-safe discriminator: a customer
  // must see that their own lens is a 'company' lens. `source_domain_id` is the external
  // mirror-lens backref (operator construction IP) and is INTENTIONALLY omitted → stripped.
  'kind',
  'created_at',
  'updated_at',
];

/**
 * Map a synthetic domain to what the caller is allowed to see. Operators get the
 * full object; everyone else gets only the tenant-safe allow-listed fields (the
 * lens's construction IP is stripped). Fail-closed: default-strip anything not on
 * the allow-list. This is the single serialization choke-point applied at every
 * tenant-facing GET return below.
 */
function toTenantSafeSyntheticDomain(
  domain: SyntheticDomain,
  isOperator: boolean,
): SyntheticDomain | Partial<SyntheticDomain> {
  if (isOperator === true) return domain;
  const safe: Partial<SyntheticDomain> = {};
  for (const key of TENANT_SAFE_SYNTHETIC_DOMAIN_FIELDS) {
    if (key in domain) (safe as Record<string, unknown>)[key] = domain[key];
  }
  return safe;
}

// Tenant scope for recommendation reads. The MB-P operator (orgless) sees their OWNED
// workspaces + cross-workspace (operator_only / NULL) rows; a customer sees ONLY their
// own workspace; anyone unscoped gets nothing (fail-closed in the DAL). This is what
// closes the prior unscoped cross-tenant read on GET /recommendations.
async function recommendationTenantScope(
  auth: { user_id?: string; workspace_id?: string },
  env: SyntheticDomainsEnv,
  dal: DalAdapter,
): Promise<{ workspaceIds: string[]; includeCrossWorkspace: boolean }> {
  if (isMbpOperator(auth.user_id, env)) {
    const owned = await dal.listWorkspacesForOperator(operatorIds(env).ids);
    return { workspaceIds: owned.map((w) => w.id), includeCrossWorkspace: true };
  }
  return { workspaceIds: auth.workspace_id ? [auth.workspace_id] : [], includeCrossWorkspace: false };
}

// POST /synthetic-domains · create
syntheticDomainsRoute.post('/synthetic-domains', async (ctx) => {
  try {
    const { workspace_id, role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot create synthetic domains (requires owner or operator)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as Partial<SyntheticDomainCreateInput> | null;
    if (!body || !body.slug || !body.label || !body.binding) {
      ctx.status(400);
      return ctx.json({ error: 'slug, label, binding required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    // Workspace tenancy: caller can only create domains in their own workspace OR cross-workspace (NULL, operator-only)
    if (body.workspace_id === undefined) body.workspace_id = workspace_id;
    if (body.workspace_id !== null && body.workspace_id !== workspace_id) {
      ctx.status(403);
      return ctx.json({ error: 'cannot create domains in another workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    if (body.workspace_id === null) {
      // Cross-workspace requires operator role; visibility hard-set to operator_only by DAL
      body.visibility = 'operator_only';
    }
    // R1 — validate the kind discriminator (fail with 400, not a DB CHECK 500).
    if (body.kind !== undefined && !['life', 'company', 'work', 'custom'].includes(body.kind)) {
      ctx.status(400);
      return ctx.json({ error: `kind must be one of life|company|work|custom`, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    // R1 — the mirror-lens backref is only valid for a kind=life lens (the off-DB
    // life-domain mirror). Fail-closed: a non-life lens may not carry source_domain_id.
    if (body.source_domain_id != null && body.kind !== 'life') {
      ctx.status(400);
      return ctx.json({ error: `source_domain_id is only valid for kind=life (mirror lens)`, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const input: SyntheticDomainCreateInput = {
      id: body.id,
      workspace_id: body.workspace_id,
      slug: body.slug,
      label: body.label,
      description: body.description ?? null,
      owner_user_id: body.owner_user_id,
      visibility: body.visibility,
      edit_role: body.edit_role,
      binding: body.binding,
      source_domains: body.source_domains,
      derivation_fingerprint: body.derivation_fingerprint,
      derivation_version: body.derivation_version,
      derivative_mutation_allowed: body.derivative_mutation_allowed,
      metadata: body.metadata,
      // R1 — carry the discriminator + mirror-lens backref through create (F4 fix:
      // without these the public API forced every lens to kind='work').
      kind: body.kind,
      source_domain_id: body.source_domain_id,
    };
    const dal = ctx.get('dal');
    const domain = await dal.createSyntheticDomain(input, user_id);
    return ctx.json({ synthetic_domain: domain });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /synthetic-domains · list
syntheticDomainsRoute.get('/synthetic-domains', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, role, user_id } = auth;
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot list synthetic domains', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const url = new URL(ctx.req.url);
    const requestedWs = url.searchParams.get('workspace_id');
    const status = (url.searchParams.get('status') ?? 'active') as SyntheticDomainStatus;
    const dal = ctx.get('dal');
    const isOperator = isOperatorContext(ctx.get('auth'), ctx.env);

    // Special sentinel: workspace_id=__cross__ requests cross-workspace listing (operator only)
    const wantsCross = requestedWs === '__cross__' || requestedWs === 'null';
    if (wantsCross && !isOperator) {
      ctx.status(403);
      return ctx.json({ error: 'cross-workspace synthetic domains visible to operators only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }

    const domains = await dal.listSyntheticDomains(
      { workspace_id: wantsCross ? null : (requestedWs ?? workspace_id), status },
      user_id,
      isOperator,
    );
    // HR-IP-BOUNDARY-1: strip the lens's construction IP for non-operators.
    return ctx.json(withDataClass(withAuthority(
      { synthetic_domains: domains.map((d) => toTenantSafeSyntheticDomain(d, isOperator)) },
      auth, 'synthetic_domain',
    ), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /synthetic-domains/:id · single
syntheticDomainsRoute.get('/synthetic-domains/:id', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, role, user_id } = auth;
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read synthetic domains', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('id');
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const isOperator = isOperatorContext(ctx.get('auth'), ctx.env);
    const domain = await dal.getSyntheticDomain(id, user_id, workspace_id, isOperator);
    if (!domain) {
      ctx.status(404);
      return ctx.json({ error: `synthetic_domain ${id} not found`, code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    // HR-IP-BOUNDARY-1: strip the lens's construction IP for non-operators.
    return ctx.json(withDataClass(withAuthority(
      { synthetic_domain: toTenantSafeSyntheticDomain(domain, isOperator) },
      auth, 'synthetic_domain',
    ), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PATCH /synthetic-domains/:id/binding · update binding
syntheticDomainsRoute.patch('/synthetic-domains/:id/binding', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot update synthetic_domain binding (requires owner or operator)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('id');
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as { binding?: SyntheticDomainBinding } | null;
    if (!body || !body.binding) {
      ctx.status(400);
      return ctx.json({ error: 'body.binding required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const domain = await dal.updateSyntheticDomainBinding(id, body.binding, user_id);
    return ctx.json({ synthetic_domain: domain });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PATCH /synthetic-domains/:id/archive · archive
syntheticDomainsRoute.patch('/synthetic-domains/:id/archive', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot archive synthetic domains (requires owner or operator)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('id');
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const domain = await dal.archiveSyntheticDomain(id, user_id);
    return ctx.json({ synthetic_domain: domain });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /synthetic-domains/:id/refresh-membership · recompute membership
syntheticDomainsRoute.post('/synthetic-domains/:id/refresh-membership', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot refresh membership (requires owner or operator)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('id');
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const result = await dal.refreshSyntheticDomainMembership(id, user_id);
    return ctx.json(result);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /synthetic-domains/:id/members · list members
syntheticDomainsRoute.get('/synthetic-domains/:id/members', async (ctx) => {
  try {
    const { workspace_id, role } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read synthetic domain members', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('id');
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const projects = await dal.listSyntheticDomainMembers(id, workspace_id, isOperatorContext(ctx.get('auth'), ctx.env));
    return ctx.json(withDataClass({ projects }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// R49' PR-3 · Planning layer · roadmap + goal endpoints
// ============================================================

// POST /synthetic-domains/:id/roadmaps · create roadmap (owner/operator)
syntheticDomainsRoute.post('/synthetic-domains/:id/roadmaps', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot create roadmaps (owner/operator only)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const domainId = ctx.req.param('id');
    const body = await ctx.req.json().catch(() => null) as Partial<SyntheticDomainRoadmapCreateInput> | null;
    if (!domainId || !body || !body.title) {
      ctx.status(400);
      return ctx.json({ error: 'title required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const roadmap = await dal.createRoadmap({
      id: body.id,
      domain_id: domainId,
      title: body.title,
      description: body.description ?? null,
      target_date: body.target_date ?? null,
      status: body.status ?? 'draft',
      metadata: body.metadata,
    }, user_id);
    return ctx.json({ roadmap });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /synthetic-domains/:id/roadmaps · list roadmaps for a domain
syntheticDomainsRoute.get('/synthetic-domains/:id/roadmaps', async (ctx) => {
  try {
    const { role } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read roadmaps', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const domainId = ctx.req.param('id');
    const url = new URL(ctx.req.url);
    const status = url.searchParams.get('status') as RoadmapStatus | null;
    const dal = ctx.get('dal');
    const roadmaps = await dal.listRoadmapsForDomain(domainId, status || undefined);
    return ctx.json({ roadmaps });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /synthetic-domain-roadmaps/:roadmapId · roadmap + items
syntheticDomainsRoute.get('/synthetic-domain-roadmaps/:roadmapId', async (ctx) => {
  try {
    const { role } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read roadmaps', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('roadmapId');
    const dal = ctx.get('dal');
    const result = await dal.getRoadmap(id);
    if (!result) {
      ctx.status(404);
      return ctx.json({ error: `roadmap ${id} not found`, code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    return ctx.json(result);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PATCH /synthetic-domain-roadmaps/:roadmapId · update roadmap
syntheticDomainsRoute.patch('/synthetic-domain-roadmaps/:roadmapId', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot update roadmaps`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('roadmapId');
    const body = await ctx.req.json().catch(() => null) as Record<string, any> | null;
    if (!body) {
      ctx.status(400);
      return ctx.json({ error: 'body required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const roadmap = await dal.updateRoadmap(id, body, user_id);
    return ctx.json({ roadmap });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /synthetic-domain-roadmaps/:roadmapId/items · append item
syntheticDomainsRoute.post('/synthetic-domain-roadmaps/:roadmapId/items', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot add roadmap items`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('roadmapId');
    const body = await ctx.req.json().catch(() => null) as Partial<SyntheticDomainRoadmapItemInput> | null;
    if (!body || !body.title) {
      ctx.status(400);
      return ctx.json({ error: 'title required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const item = await dal.addRoadmapItem(id, body as SyntheticDomainRoadmapItemInput, user_id);
    return ctx.json({ item });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PATCH /synthetic-domain-roadmap-items/:itemId · update item
syntheticDomainsRoute.patch('/synthetic-domain-roadmap-items/:itemId', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot update items`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('itemId');
    const body = await ctx.req.json().catch(() => null) as Record<string, any> | null;
    if (!body) {
      ctx.status(400);
      return ctx.json({ error: 'body required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const item = await dal.updateRoadmapItem(id, body, user_id);
    return ctx.json({ item });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// DELETE /synthetic-domain-roadmap-items/:itemId
syntheticDomainsRoute.delete('/synthetic-domain-roadmap-items/:itemId', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot delete items`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('itemId');
    const dal = ctx.get('dal');
    await dal.deleteRoadmapItem(id, user_id);
    return ctx.json({ deleted: id });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /synthetic-domain-roadmap-items/:itemId/restore · 044 · un-delete a soft-deleted item
syntheticDomainsRoute.post('/synthetic-domain-roadmap-items/:itemId/restore', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot restore items`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('itemId');
    const dal = ctx.get('dal');
    const item = await dal.restoreRoadmapItem(id, user_id);
    return ctx.json({ restored: item });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /synthetic-domain-roadmaps/:roadmapId/reorder · reorder items
syntheticDomainsRoute.post('/synthetic-domain-roadmaps/:roadmapId/reorder', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot reorder`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('roadmapId');
    const body = await ctx.req.json().catch(() => null) as { item_ids?: string[] } | null;
    if (!body || !Array.isArray(body.item_ids)) {
      ctx.status(400);
      return ctx.json({ error: 'item_ids array required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const items = await dal.reorderRoadmapItems(id, body.item_ids, user_id);
    return ctx.json({ items });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ---- Goals ----

syntheticDomainsRoute.post('/synthetic-domains/:id/goals', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot create goals (owner/operator only)`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const domainId = ctx.req.param('id');
    const body = await ctx.req.json().catch(() => null) as Partial<SyntheticDomainGoalCreateInput> | null;
    if (!body || !body.title || !body.metric_name || typeof body.target_value !== 'number' || !body.derivation) {
      ctx.status(400);
      return ctx.json({ error: 'title, metric_name, target_value, derivation required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    // A7 SHADOW (POLICY_ENGINE_ENABLED, default off ⇒ no-op): observe would-fire policy outcomes on the
    // real create payload — this is where the ABS-P2 placeholder-metric fabrication happened. Never enforces.
    observePolicyShadow(ctx.env, { action: 'goal.create', fields: body as Record<string, unknown>, role }, { domain_id: domainId });
    const dal = ctx.get('dal');
    const goal = await dal.createGoal({
      id: body.id,
      domain_id: domainId,
      roadmap_id: body.roadmap_id ?? null,
      title: body.title,
      description: body.description ?? null,
      metric_name: body.metric_name,
      metric_unit: body.metric_unit ?? null,
      target_value: body.target_value,
      target_date: body.target_date ?? null,
      status: body.status ?? 'active',
      derivation: body.derivation,
      metadata: body.metadata,
      // SE-1 SMART-ER layer (mig 069) — optional passthrough.
      tier: body.tier ?? null,
      ikigai_axes: body.ikigai_axes ?? [],
      future_state: body.future_state ?? null,
      review_cadence: body.review_cadence ?? null,
      review_due: body.review_due ?? null,
      source_goal_id: body.source_goal_id ?? null,
      goal_metric_contract: body.goal_metric_contract ?? null,
    }, user_id);
    return ctx.json({ goal });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

syntheticDomainsRoute.get('/synthetic-domains/:id/goals', async (ctx) => {
  try {
    const { role } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read goals', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const domainId = ctx.req.param('id');
    const url = new URL(ctx.req.url);
    const status = url.searchParams.get('status') as GoalStatus | null;
    const dal = ctx.get('dal');
    const goals = await dal.listGoalsForDomain(domainId, status || undefined);
    return ctx.json({ goals });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

syntheticDomainsRoute.get('/synthetic-domain-goals/:goalId', async (ctx) => {
  try {
    const { role } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read goals', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('goalId');
    const dal = ctx.get('dal');
    const goal = await dal.getGoal(id);
    if (!goal) {
      ctx.status(404);
      return ctx.json({ error: `goal ${id} not found`, code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    return ctx.json({ goal });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

syntheticDomainsRoute.patch('/synthetic-domain-goals/:goalId', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot update goals`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('goalId');
    const body = await ctx.req.json().catch(() => null) as Record<string, any> | null;
    if (!body) {
      ctx.status(400);
      return ctx.json({ error: 'body required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    // A7 SHADOW (POLICY_ENGINE_ENABLED, default off ⇒ no-op): a completion (status achieved/done/completed)
    // is where evidence-required-for-completion would fire; a soft-archive maps to goal.archive. Never enforces.
    const shadowAction = (body.status === 'achieved' || body.status === 'done' || body.status === 'completed')
      ? 'goal.complete'
      : (body.status === 'abandoned' ? 'goal.archive' : 'goal.update');
    observePolicyShadow(ctx.env, { action: shadowAction, fields: body as Record<string, unknown>, role }, { goal_id: id });
    // Normalize completion aliases AT THE EDGE (W2 R3 / audit gap G7): the UI and the shadow-policy
    // block above both recognise done/completed, but the DB CHECK (006:101) admits only
    // proposed|active|achieved|abandoned — passing an alias through raw is a latent 500.
    // The DB vocabulary is the glossary truth; aliases never widen the CHECK.
    if (body.status === 'done' || body.status === 'completed') body.status = 'achieved';
    const dal = ctx.get('dal');
    const goal = await dal.updateGoal(id, body, user_id);
    return ctx.json({ goal });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

syntheticDomainsRoute.post('/synthetic-domain-goals/:goalId/recompute', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot recompute goals`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('goalId');
    const dal = ctx.get('dal');
    const result = await dal.recomputeGoalValue(id, user_id, null);
    return ctx.json(result);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

syntheticDomainsRoute.get('/synthetic-domain-goals/:goalId/progress', async (ctx) => {
  try {
    const { role } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read goal progress', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('goalId');
    const url = new URL(ctx.req.url);
    const limit = parseInt(url.searchParams.get('limit') || '100', 10) || 100;
    const dal = ctx.get('dal');
    const progress = await dal.listGoalProgress(id, limit);
    return ctx.json({ progress });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// R49' PR-5+6 · Propagation rules + recommendations endpoints
// ============================================================

// POST /synthetic-domains/:id/propagation-rules
syntheticDomainsRoute.post('/synthetic-domains/:id/propagation-rules', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot create propagation rules`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const domainId = ctx.req.param('id');
    const body = await ctx.req.json().catch(() => null) as Partial<PropagationRuleCreateInput> | null;
    if (!body || !body.name || !body.trigger || !body.action) {
      ctx.status(400);
      return ctx.json({ error: 'name, trigger, action required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const rule = await dal.createPropagationRule({
      id: body.id,
      domain_id: domainId,
      name: body.name,
      description: body.description ?? null,
      trigger: body.trigger,
      action: body.action,
      status: body.status ?? 'active',
    }, user_id);
    return ctx.json({ rule });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /synthetic-domains/:id/propagation-rules
syntheticDomainsRoute.get('/synthetic-domains/:id/propagation-rules', async (ctx) => {
  try {
    const { role } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read propagation rules', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const domainId = ctx.req.param('id');
    const url = new URL(ctx.req.url);
    const status = url.searchParams.get('status') as PropagationRuleStatus | null;
    const dal = ctx.get('dal');
    const rules = await dal.listPropagationRulesForDomain(domainId, status || undefined);
    return ctx.json({ rules });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PATCH /synthetic-domain-propagation-rules/:ruleId
syntheticDomainsRoute.patch('/synthetic-domain-propagation-rules/:ruleId', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot update propagation rules`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('ruleId');
    const body = await ctx.req.json().catch(() => null) as Record<string, any> | null;
    if (!body) {
      ctx.status(400);
      return ctx.json({ error: 'body required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const rule = await dal.updatePropagationRule(id, body, user_id);
    return ctx.json({ rule });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PATCH /synthetic-domain-propagation-rules/:ruleId/archive
syntheticDomainsRoute.patch('/synthetic-domain-propagation-rules/:ruleId/archive', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot archive propagation rules`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('ruleId');
    const dal = ctx.get('dal');
    const rule = await dal.archivePropagationRule(id, user_id);
    return ctx.json({ rule });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /synthetic-domains/:id/recommendations
syntheticDomainsRoute.get('/synthetic-domains/:id/recommendations', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (auth.role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read recommendations', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const domainId = ctx.req.param('id');
    const url = new URL(ctx.req.url);
    const status = (url.searchParams.get('status') as RecommendationStatus | null) ?? 'pending';
    const limit = parseInt(url.searchParams.get('limit') || '100', 10) || 100;
    const dal = ctx.get('dal');
    // OWNERSHIP (audit 260531): the caller must be able to read the PARENT domain before
    // its recommendations — reuses the scoped getter (null if not accessible) so a by-id
    // call cannot read another tenant's recommendations.
    const domain = await dal.getSyntheticDomain(domainId, auth.user_id, auth.workspace_id, isOperatorContext(auth, ctx.env));
    if (!domain) {
      ctx.status(404);
      return ctx.json({ error: `synthetic_domain ${domainId} not found`, code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    const recommendations = await dal.listRecommendations({ domain_id: domainId, status, limit });
    return ctx.json({ recommendations });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /synthetic-domain-recommendations/:id
syntheticDomainsRoute.get('/synthetic-domain-recommendations/:id', async (ctx) => {
  try {
    const { role } = ctx.get('auth');
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read recommendations', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('id');
    const dal = ctx.get('dal');
    const recommendation = await dal.getRecommendation(id);
    if (!recommendation) {
      ctx.status(404);
      return ctx.json({ error: `recommendation ${id} not found`, code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    return ctx.json({ recommendation });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /synthetic-domain-recommendations/:id/accept
//
// R51-δ-B4 extension: LEM-v4-aware accept. When the recommendation row
// carries a pattern_fingerprint (LEM-v4 emission column from migration 009),
// the audit trail is enriched in the response with the emission breakdown
// so the operator's audit-log surface (and any future learning loop) can
// trace "what got accepted" without a second query.
//
// Backward-compat: legacy LEM-v3 callers receive the same shape they always
// did. New callers see an additional `lem_v4_audit` field when applicable.
syntheticDomainsRoute.post('/synthetic-domain-recommendations/:id/accept', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot accept recommendations`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('id');
    const body = await ctx.req.json().catch(() => null) as { note?: string } | null;
    const dal = ctx.get('dal');
    // R55-3c · resolve the caller's tenant scope so the DAL rejects any write to a
    // recommendation outside it (operator: owned + cross-workspace; customer: own ws).
    const scope = await recommendationTenantScope(ctx.get('auth'), ctx.env, dal);
    // Step 1 (LEM-v3 preserved): existing accept path — status flip +
    // payload-apply + audit log.
    const recommendation = await dal.acceptRecommendation(id, user_id, body?.note, scope);

    // Step 2 (LEM-v4 added): if the recommendation has a pattern_fingerprint,
    // it was emitted by the detector engine (Wave δ-B3) — surface the
    // audit linkage so the UI can render "you accepted: signal_X=0.85,
    // signal_Y=0.72, ..." without an extra round-trip.
    let lem_v4_audit: unknown = null;
    const patternFingerprint = (recommendation as any).pattern_fingerprint as string | null | undefined;
    if (patternFingerprint) {
      // The inference_emissions row is uniquely identified by recommendation_id.
      // Query is cheap via idx_ie_recommendation (migration 009).
      // We don't have a dedicated DAL method for "find emission by recommendation_id"
      // yet — Wave ε will add it. For now, surface the LEM-v4 columns already
      // present on the recommendation row.
      lem_v4_audit = {
        evidence_score: (recommendation as any).evidence_score ?? null,
        composite_confidence: (recommendation as any).composite_confidence ?? null,
        pattern_fingerprint: patternFingerprint,
        signal_contribution_breakdown: (recommendation as any).signal_contribution_breakdown ?? null,
        detector_config_version_id: (recommendation as any).detector_config_version_id ?? null,
      };
    }
    return ctx.json({ recommendation, lem_v4_audit });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /synthetic-domain-recommendations/:id/reject
//
// R51-δ-A3 extension: in addition to the LEM-v3 status update via
// dal.rejectRecommendation, this route ALSO writes to the LEM-v4
// recommendation_rejections anti-rec memory table (§16.6) when the
// recommendation row carries a pattern_fingerprint (LEM-v4 emissions
// always do; LEM-v3 legacy rows do not).
//
// Backward-compat:
//   - Body  `{ note }`            (legacy) → LEM-v3 reject ONLY
//   - Body  `{ note, reason_taxonomy }`   → LEM-v3 reject + LEM-v4 anti-rec write
//   - Body  `{ note, reason_taxonomy, suppress_permanently }` → adds
//     permanent_suppress_fingerprint to the anti-rec row (per-pattern
//     suppress; future emissions skip this fingerprint)
//
// Accepted reason_taxonomy values (matches CHECK constraint in migration 009):
//   'not_relevant','too_broad','too_narrow','already_exists',
//   'privacy_concern','wrong_grouping','timing','other'
syntheticDomainsRoute.post('/synthetic-domain-recommendations/:id/reject', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot reject recommendations`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = ctx.req.param('id');
    const body = await ctx.req.json().catch(() => null) as {
      note?: string;
      reason_taxonomy?: string;
      suppress_permanently?: boolean;
    } | null;
    if (!body || !body.note || body.note.trim().length === 0) {
      ctx.status(400);
      return ctx.json({ error: 'note required for reject', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    // Optional taxonomy validation (mirror the CHECK in migration 009)
    const VALID_TAXONOMY = new Set([
      'not_relevant', 'too_broad', 'too_narrow', 'already_exists',
      'privacy_concern', 'wrong_grouping', 'timing', 'other',
    ]);
    if (body.reason_taxonomy && !VALID_TAXONOMY.has(body.reason_taxonomy)) {
      ctx.status(400);
      return ctx.json({
        error: `invalid reason_taxonomy "${body.reason_taxonomy}"; valid: ${[...VALID_TAXONOMY].join(', ')}`,
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    const dal = ctx.get('dal');
    // R55-3c · same tenant write guard as accept.
    const scope = await recommendationTenantScope(ctx.get('auth'), ctx.env, dal);

    // Step 1 (LEM-v3): perform the existing status update + audit log.
    const recommendation = await dal.rejectRecommendation(id, user_id, body.note, scope);

    // Step 2 (LEM-v4): if the recommendation carries a pattern_fingerprint
    // (added by migration 009 ALTER), also write the anti-rec memory row.
    // pattern_fingerprint is read from the live row to avoid trusting the
    // client. cast through `any` because the rejectRecommendation return
    // shape is the legacy LEM-v3 type — the new column is forward-compat.
    let anti_rec_audit: unknown = null;
    const patternFingerprint = (recommendation as any).pattern_fingerprint as string | null | undefined;
    if (patternFingerprint) {
      anti_rec_audit = await dal.insertRecommendationRejection({
        recommendation_id: id,
        rejected_by: user_id,
        reason_text: body.note,
        reason_taxonomy: (body.reason_taxonomy as any) ?? null,
        permanent_suppress_fingerprint: body.suppress_permanently ? patternFingerprint : null,
        pattern_fingerprint_at_reject: patternFingerprint,
      });
    }

    return ctx.json({ recommendation, anti_rec_audit });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /admin/propagation-tick · operator can force a tick on demand (Cron also runs this)
syntheticDomainsRoute.post('/admin/propagation-tick', async (ctx) => {
  try {
    const { role, user_id } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot run propagation tick`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const result = await dal.runPropagationTick(user_id);
    return ctx.json(result);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// R51-δ-B4 · LEM-v4 recommendation reads + operator-triggered detector
// ──────────────────────────────────────────────────────────────────────

// GET /recommendations  (mounted under /api/v1 in workers/index.ts; full path: /api/v1/recommendations)
//
// Workspace-wide pending recommendations list. Returns all pending
// recommendations across the caller's active synthetic domains.
// Operator/Owner sees all; Client cannot read recommendations.
// Optional query params:
//   ?status=pending|accepted|rejected|expired|superseded  (default: pending)
//   ?limit=N  (default 100, max 500)
//   ?has_lem_v4=true|false  (filter by presence of pattern_fingerprint)
//
// Wave ε recommendations inbox UI consumes this. The list is auto-scoped
// to the caller's workspace_memberships via DAL.
//
// NOTE: route literal MUST be '/recommendations' (no /api/v1 prefix) because
// syntheticDomainsRoute is mounted under /api/v1 in src/workers/index.ts.
// Wave δ-B4 originally double-prefixed this; corrected in Wave ε-0.
syntheticDomainsRoute.get('/recommendations', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (auth.role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read recommendations', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const url = new URL(ctx.req.url);
    const status = (url.searchParams.get('status') as RecommendationStatus | null) ?? 'pending';
    const limitParam = parseInt(url.searchParams.get('limit') || '100', 10) || 100;
    const limit = Math.min(500, Math.max(1, limitParam));
    const has_lem_v4_param = url.searchParams.get('has_lem_v4');
    const dal = ctx.get('dal');
    // TENANT SCOPING (audit 260531): recommendations are scoped to the caller's tenant —
    // the operator sees their owned workspaces + cross-workspace rows; a customer sees
    // ONLY their own workspace; an unscoped caller gets nothing (fail-closed in the DAL).
    // Closes the prior cross-tenant read where listRecommendations returned ALL rows.
    const { workspaceIds, includeCrossWorkspace } = await recommendationTenantScope(auth, ctx.env, dal);
    const recommendations = await dal.listRecommendations({ status, limit, workspaceIds, includeCrossWorkspace });
    // Optional has_lem_v4 client-side filter (cheap; recommendations list
    // is bounded by limit=500).
    const filtered = (() => {
      if (has_lem_v4_param === 'true') {
        return recommendations.filter((r: any) => Boolean(r.pattern_fingerprint));
      }
      if (has_lem_v4_param === 'false') {
        return recommendations.filter((r: any) => !r.pattern_fingerprint);
      }
      return recommendations;
    })();
    return ctx.json({ recommendations: filtered, count: filtered.length });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /admin/detector-tick · operator-triggered manual detector run.
//
// Body (all optional):
//   {
//     candidates: DetectorCandidate[],   // if omitted, runs against an empty
//                                         // list (proves engine reachable)
//     window_start?: ISO8601,            // default: now - 30 days
//     window_end?: ISO8601,              // default: now
//     kind?: 'manual_trigger' | 'scheduled_cron'
//   }
//
// Returns the DetectorTickResult shape from detector-engine.ts so the
// operator can see counts + per-candidate evaluations (with rejection
// reasons) for the tick.
//
// Cron registration deferred to Wave ζ (alongside the 5 other self-
// maintenance crons).
syntheticDomainsRoute.post('/admin/detector-tick', async (ctx) => {
  try {
    const { role } = ctx.get('auth');
    if (!isOperatorContext(ctx.get('auth'), ctx.env)) {
      ctx.status(403);
      return ctx.json({ error: `role ${role} cannot run detector tick`, code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = (await ctx.req.json().catch(() => null)) as {
      candidates?: any[];
      window_start?: string;
      window_end?: string;
      kind?: 'manual_trigger' | 'scheduled_cron';
    } | null;

    // Default window: trailing 30 days.
    const now = new Date();
    const window_end = body?.window_end ?? now.toISOString();
    const window_start =
      body?.window_start ??
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const candidates = Array.isArray(body?.candidates) ? body!.candidates : [];

    // Lazy-import the detector engine so this route doesn't pull the
    // inference module graph for unrelated requests.
    const { runDetectorTick } = await import('../inference/detector-engine');
    const dal = ctx.get('dal');
    const result = await runDetectorTick({
      dal,
      candidates,
      window_start,
      window_end,
      kind: body?.kind ?? 'manual_trigger',
    });
    return ctx.json(result);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
