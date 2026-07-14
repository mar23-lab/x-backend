// synthetic-domains-ip-boundary.test.ts · HR-IP-BOUNDARY-1 (ADR-XLOOP-IA-001 Phase B)
//
// The enforceable TEETH for the synthetic-domain IP boundary. A synthetic domain is
// a LENS the operator constructs over the tenant fleet; its construction IP — the
// binding FILTERS, the source-domain lineage, and the derivation fingerprint/version/
// mutation policy — must never reach a tenant. These tests pin two negatives:
//
//   (c) IP-strip · a NON-operator GET (list + by-id) omits the construction-IP fields;
//       an OPERATOR GET still includes them (operator console is unchanged).
//   (d) Isolation · a NON-operator requesting workspace_id=null (cross-workspace) gets
//       403 — the route-level guard backed by synthetic-domain-store.ts L341-342.
//
// Harness mirrors synthetic-domains-recommendations.test.ts: Hono app + a mocked DAL
// that EMULATES the real store contract (the cross-workspace 403 guard), so the test
// asserts the ROUTE enforces the boundary end-to-end without a live DB.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { syntheticDomainsRoute } from '../routes/synthetic-domains';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '' };

// The four fields the verified leak named — the explicit IP-strip contract.
const IP_FIELDS = [
  'derivation_fingerprint',
  'derivation_version',
  'derivative_mutation_allowed',
  'source_domains',
] as const;

// The COMPLETE set a non-operator must NEVER receive: the 4 named IP fields, plus the
// binding FILTERS themselves and operator-internal authorship. A catch-all so a future
// field added to SyntheticDomain cannot silently re-open the leak without failing here.
const FORBIDDEN_FOR_TENANT = [
  'binding',
  'binding_version',
  'source_domains',
  'derivation_fingerprint',
  'derivation_version',
  'derivative_mutation_allowed',
  'owner_user_id',
  'edit_role',
  'binding_updated_at',
  'binding_updated_by',
  // R1 — the mirror-lens backref to an external MB-P life-domain node is operator
  // construction IP and must NEVER reach a tenant (only `kind` is tenant-safe).
  'source_domain_id',
] as const;

// The EXACT tenant-safe allow-list the projection is permitted to emit.
const TENANT_SAFE_FIELDS = [
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
  // R1 — the domain discriminator (life|company|work|custom) is tenant-safe: a customer
  // must see that their own lens is a 'company' lens.
  'kind',
  'created_at',
  'updated_at',
] as const;

// A full synthetic-domain row exactly as the DAL serializes it (normalizeSyntheticDomainRow),
// INCLUDING every construction-IP field a tenant must never receive.
const FULL_DOMAIN = {
  id: 'sd_high_velocity',
  workspace_id: 'me',
  slug: 'high-velocity',
  label: 'High Velocity',
  description: 'lens for fast-moving accounts',
  owner_user_id: MBP_OWNER,
  visibility: 'workspace',
  edit_role: 'operator',
  binding: { version: 1, combine: 'any', filters: [{ type: 'status_in', values: ['active'] }] },
  binding_version: 3,
  source_domains: ['dom_alpha', 'dom_beta'],
  derivation_fingerprint: 'fp_deadbeefcafe',
  derivation_version: 2,
  derivative_mutation_allowed: ['relabel', 'rescope'],
  status: 'active',
  has_roadmap: true,
  goal_count: 2,
  open_recommendation_count: 1,
  metadata: { tags: ['priority'] },
  // R1 (migration 028) — a real serialized row now carries these. kind is tenant-safe;
  // source_domain_id (the external mirror-lens backref) is operator IP and must be stripped.
  kind: 'company',
  source_domain_id: 'dom_external_mbp_companies',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-09T00:00:00.000Z',
  binding_updated_at: '2026-06-09T00:00:00.000Z',
  binding_updated_by: MBP_OWNER,
};

function mockDal() {
  return {
    listWorkspacesForOperator: async () => [{ id: 'me' }],
    // EMULATES the real store guard (synthetic-domain-store.ts L341-342): a
    // cross-workspace (workspace_id === null) list by a NON-operator is FORBIDDEN.
    // Defense-in-depth — the route returns 403 BEFORE reaching here, but a faithful
    // mock means the test still bites if the route guard is ever removed.
    listSyntheticDomains: async (opts: any, _uid: string, isOperator: boolean) => {
      if (opts.workspace_id === null && !isOperator) {
        const e: any = new Error('cross-workspace synthetic domains visible to operators only');
        e.code = 'FORBIDDEN';
        e.status = 403;
        throw e;
      }
      return [FULL_DOMAIN];
    },
    getSyntheticDomain: async () => FULL_DOMAIN,
  };
}

function appFor(auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', mockDal() as never);
    await next();
  });
  app.route('/api/v1', syntheticDomainsRoute);
  return app;
}

const get = (auth: Record<string, unknown>, path: string) =>
  appFor(auth).request(path, {}, ENV as never);

// A tenant who can list/read but is NOT an operator (role not owner/operator/client,
// user_id not an MB-P operator id).
const TENANT = { user_id: 'user_customer', role: 'member', workspace_id: 'me' };
// Operators: one by ROLE, one by orgless MB-P user_id (role resolves to viewer).
const OPERATOR_BY_ROLE = { user_id: 'user_op', role: 'operator', workspace_id: 'me' };
const OPERATOR_BY_MBP_ID = { user_id: MBP_OWNER, role: 'viewer', workspace_id: 'me' };

describe('(c) IP-strip · GET /synthetic-domains (list)', () => {
  it('NON-operator: each domain omits the construction-IP fields, keeps the tenant-safe fields', async () => {
    const res = await get(TENANT, '/api/v1/synthetic-domains?workspace_id=me');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.synthetic_domains)).toBe(true);
    const d = body.synthetic_domains[0];
    // IP stripped (the 4 named fields)…
    for (const f of IP_FIELDS) expect(d).not.toHaveProperty(f);
    // …plus the binding FILTERS themselves and operator-internal authorship.
    expect(d).not.toHaveProperty('binding');
    expect(d).not.toHaveProperty('binding_updated_by');
    // Tenant-safe payload survives: label + membership + visibility (+ identity).
    expect(d.id).toBe('sd_high_velocity');
    expect(d.label).toBe('High Velocity');
    expect(d.visibility).toBe('workspace');
    expect(d.goal_count).toBe(2);
    expect(d.open_recommendation_count).toBe(1);
  });

  it('OPERATOR (by role): each domain STILL includes the construction-IP fields', async () => {
    const res = await get(OPERATOR_BY_ROLE, '/api/v1/synthetic-domains?workspace_id=me');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const d = body.synthetic_domains[0];
    for (const f of IP_FIELDS) expect(d).toHaveProperty(f);
    expect(d.binding).toBeTruthy();
    expect(d.derivation_fingerprint).toBe('fp_deadbeefcafe');
  });

  it('OPERATOR (by orgless MB-P user_id): construction-IP fields present', async () => {
    const res = await get(OPERATOR_BY_MBP_ID, '/api/v1/synthetic-domains?workspace_id=me');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const d = body.synthetic_domains[0];
    for (const f of IP_FIELDS) expect(d).toHaveProperty(f);
  });
});

describe('(c) IP-strip · GET /synthetic-domains/:id (by id)', () => {
  it('NON-operator: omits the construction-IP fields, keeps label/visibility', async () => {
    const res = await get(TENANT, '/api/v1/synthetic-domains/sd_high_velocity');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const d = body.synthetic_domain;
    for (const f of IP_FIELDS) expect(d).not.toHaveProperty(f);
    expect(d).not.toHaveProperty('binding');
    expect(d.label).toBe('High Velocity');
    expect(d.visibility).toBe('workspace');
  });

  it('OPERATOR: includes the construction-IP fields unchanged', async () => {
    const res = await get(OPERATOR_BY_ROLE, '/api/v1/synthetic-domains/sd_high_velocity');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const d = body.synthetic_domain;
    for (const f of IP_FIELDS) expect(d).toHaveProperty(f);
    expect(d.source_domains).toEqual(['dom_alpha', 'dom_beta']);
  });
});

describe('(c+) IP-strip · catch-all field-boundary lock', () => {
  it('NON-operator (list): response keys are EXACTLY the tenant-safe allow-list — no more', async () => {
    const res = await get(TENANT, '/api/v1/synthetic-domains?workspace_id=me');
    const body: any = await res.json();
    const keys = Object.keys(body.synthetic_domains[0]).sort();
    expect(keys).toEqual([...TENANT_SAFE_FIELDS].sort());
  });

  it('NON-operator (by-id): NONE of the forbidden fields appear', async () => {
    const res = await get(TENANT, '/api/v1/synthetic-domains/sd_high_velocity');
    const body: any = await res.json();
    const d = body.synthetic_domain;
    for (const f of FORBIDDEN_FOR_TENANT) expect(d).not.toHaveProperty(f);
  });

  it('OPERATOR: receives the COMPLETE field set (no accidental over-strip)', async () => {
    const res = await get(OPERATOR_BY_ROLE, '/api/v1/synthetic-domains/sd_high_velocity');
    const body: any = await res.json();
    const keys = Object.keys(body.synthetic_domain).sort();
    expect(keys).toEqual([...TENANT_SAFE_FIELDS, ...FORBIDDEN_FOR_TENANT].sort());
  });
});

describe('(d) Isolation · cross-workspace (workspace_id=null) is operator-only', () => {
  it('NON-operator requesting workspace_id=null → 403', async () => {
    const res = await get(TENANT, '/api/v1/synthetic-domains?workspace_id=null');
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.code).toBe('FORBIDDEN');
  });

  it('NON-operator requesting workspace_id=__cross__ → 403', async () => {
    const res = await get(TENANT, '/api/v1/synthetic-domains?workspace_id=__cross__');
    expect(res.status).toBe(403);
  });

  it('OPERATOR requesting workspace_id=null → 200 (not 403), full IP-bearing rows', async () => {
    const res = await get(OPERATOR_BY_ROLE, '/api/v1/synthetic-domains?workspace_id=null');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const d = body.synthetic_domains[0];
    for (const f of IP_FIELDS) expect(d).toHaveProperty(f);
  });
});
