// plan-route.test.ts · /api/v1/plan/* (G1 · customer plan_entities facade)
//
// Injects auth + a fake dal and asserts the route contract: the PLAN_ENTITIES_ENABLED flag gate, the
// member + role!='client' RBAC, body validation, tenancy 404 (getPlanEntity), and DAL delegation.
// Mirrors members-role-mutation.test.ts (no DB — the store SQL is exercised separately).
//
// Authority: src/workers/routes/plan.ts + src/workers/dal/plan-store.ts

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { planRoute } from '../routes/plan';

const ON = { PLAN_ENTITIES_ENABLED: 'true' } as const;

function appFor(
  dal: Record<string, unknown>,
  auth: { user_id: string; workspace_id: string; role?: string } = { user_id: 'op', workspace_id: 'org_a', role: 'operator' },
) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't');
    ctx.set('auth', auth as never);
    ctx.set('dal', { ...dal, plan: dal } as never);
    await next();
  });
  app.route('/api/v1', planRoute);
  return app;
}

const entity = {
  id: 'ple_1', workspace_id: 'org_a', scope_id: 'scope_x', scope_type: 'workspace', parent_id: null,
  kind: 'goal', title: 'Ship G1', summary: null, status: 'open', position: 0, target_date: null,
  derived_from: null, promoted_to_intent_id: null, created_by: 'op', updated_by: 'op',
  created_at: '2026-07-11T00:00:00Z', updated_at: '2026-07-11T00:00:00Z',
};

describe('GET /plan/:scopeId', () => {
  it('200 — lists entities; DAL called with (scopeId, {workspaceId}); data_class live', async () => {
    const listPlanEntities = vi.fn(async () => [entity]);
    const res = await appFor({ listPlanEntities }).request('/api/v1/plan/scope_x', {}, ON);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { scope_id: string; entities: unknown[]; data_class: string };
    expect(j.scope_id).toBe('scope_x');
    expect(j.entities).toHaveLength(1);
    expect(j.data_class).toBe('live');
    expect(listPlanEntities).toHaveBeenCalledWith('scope_x', { workspaceId: 'org_a' });
  });

  it('404 — flag OFF makes the surface inert; DAL never called', async () => {
    const listPlanEntities = vi.fn(async () => []);
    const res = await appFor({ listPlanEntities }).request('/api/v1/plan/scope_x', {}, {}); // env present, flag absent
    expect(res.status).toBe(404);
    expect(listPlanEntities).not.toHaveBeenCalled();
  });

  it('403 — client role cannot access the plan surface', async () => {
    const listPlanEntities = vi.fn(async () => []);
    const app = appFor({ listPlanEntities }, { user_id: 'c', workspace_id: 'org_a', role: 'client' });
    const res = await app.request('/api/v1/plan/scope_x', {}, ON);
    expect(res.status).toBe(403);
    expect(listPlanEntities).not.toHaveBeenCalled();
  });

  it('401 — no authenticated user', async () => {
    const res = await appFor({ listPlanEntities: vi.fn() }, { user_id: '', workspace_id: '' }).request('/api/v1/plan/scope_x', {}, ON);
    expect(res.status).toBe(401);
  });
});

function jsonReq(app: ReturnType<typeof appFor>, path: string, method: string, body: unknown) {
  return app.request(path, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `test:${method}:${path}` },
  }, ON);
}

function authorityReceipt(operation: 'create' | 'update' | 'delete', value = entity) {
  const updatedAt = operation === 'delete' ? '2026-07-11T00:01:00Z' : value.updated_at;
  return {
    entity: operation === 'delete' ? null : value,
    deleted: operation === 'delete' ? { id: value.id, updated_at: updatedAt } : null,
    plan_entity_id: value.id,
    plan_revision_id: `plan:${operation}:${value.id}:${updatedAt}`,
    operation,
    receipt_id: `plan:${operation}:${value.id}:evt_1`,
    operation_event_id: 'evt_1',
    audit_event_id: '1',
    projection_outbox_id: 'out_1',
    read_model_watermark: updatedAt,
    replayed: false,
  };
}

describe('POST /plan/entity', () => {
  it('201 — creates an entity; DAL called with (input incl workspace_id + kind, actor)', async () => {
    const createPlanEntity = vi.fn(async () => authorityReceipt('create'));
    const res = await jsonReq(appFor({ createPlanEntity }), '/api/v1/plan/entity', 'POST', {
      scope_id: 'scope_x', scope_type: 'workspace', kind: 'goal', title: 'Ship G1',
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { entity: { id: string }; plan_entity_id: string; plan_revision_id: string; operation: string };
    expect(j.entity.id).toBe('ple_1');
    expect(j.plan_entity_id).toBe('ple_1');
    expect(j.plan_revision_id).toBe('plan:create:ple_1:2026-07-11T00:00:00Z');
    expect(j.operation).toBe('create');
    expect(createPlanEntity).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 'org_a', scope_id: 'scope_x', kind: 'goal', title: 'Ship G1' }),
      'op',
      expect.objectContaining({ key: 'test:POST:/api/v1/plan/entity', route: 'POST /api/v1/plan/entity' }),
    );
  });

  it('428 — refuses a write without an Idempotency-Key', async () => {
    const createPlanEntity = vi.fn();
    const res = await appFor({ createPlanEntity }).request('/api/v1/plan/entity', {
      method: 'POST', body: JSON.stringify({ kind: 'goal', title: 'No key' }),
      headers: { 'content-type': 'application/json' },
    }, ON);
    expect(res.status).toBe(428);
    expect(createPlanEntity).not.toHaveBeenCalled();
  });

  it('400 — invalid kind rejected before any DAL call', async () => {
    const createPlanEntity = vi.fn();
    const res = await jsonReq(appFor({ createPlanEntity }), '/api/v1/plan/entity', 'POST', { kind: 'epic', title: 'x' });
    expect(res.status).toBe(400);
    expect(createPlanEntity).not.toHaveBeenCalled();
  });

  it('400 — missing title rejected before any DAL call', async () => {
    const createPlanEntity = vi.fn();
    const res = await jsonReq(appFor({ createPlanEntity }), '/api/v1/plan/entity', 'POST', { kind: 'todo' });
    expect(res.status).toBe(400);
    expect(createPlanEntity).not.toHaveBeenCalled();
  });
});

describe('PATCH /plan/entity/:id', () => {
  it('200 — updates; getPlanEntity tenancy-check then updatePlanEntity(id, patch, actor)', async () => {
    const getPlanEntity = vi.fn(async () => entity);
    const updated = { ...entity, title: 'Renamed', position: 2 };
    const updatePlanEntity = vi.fn(async () => authorityReceipt('update', updated));
    const res = await jsonReq(appFor({ getPlanEntity, updatePlanEntity }), '/api/v1/plan/entity/ple_1', 'PATCH', { title: 'Renamed', position: 2 });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { entity: { id: string; title: string }; plan_entity_id: string; plan_revision_id: string; operation: string };
    expect(j.entity.title).toBe('Renamed');
    expect(j.plan_entity_id).toBe('ple_1');
    expect(j.plan_revision_id).toBe('plan:update:ple_1:2026-07-11T00:00:00Z');
    expect(j.operation).toBe('update');
    expect(getPlanEntity).toHaveBeenCalledWith('ple_1', 'org_a');
    expect(updatePlanEntity).toHaveBeenCalledWith(
      entity,
      { title: 'Renamed', position: 2 },
      'op',
      expect.objectContaining({ key: 'test:PATCH:/api/v1/plan/entity/ple_1', route: 'PATCH /api/v1/plan/entity/ple_1' }),
    );
  });

  it('404 — tenancy: entity not in caller workspace; updatePlanEntity never called', async () => {
    const getPlanEntity = vi.fn(async () => null);
    const updatePlanEntity = vi.fn();
    const res = await jsonReq(appFor({ getPlanEntity, updatePlanEntity }), '/api/v1/plan/entity/ple_x', 'PATCH', { title: 'X' });
    expect(res.status).toBe(404);
    expect(updatePlanEntity).not.toHaveBeenCalled();
  });

  it('400 — no updatable fields', async () => {
    const getPlanEntity = vi.fn();
    const res = await jsonReq(appFor({ getPlanEntity }), '/api/v1/plan/entity/ple_1', 'PATCH', { nope: 1 });
    expect(res.status).toBe(400);
    expect(getPlanEntity).not.toHaveBeenCalled();
  });

  it('200 — explicit parent_id:null reparents to top-level (key-presence honoured)', async () => {
    const getPlanEntity = vi.fn(async () => entity);
    const updatePlanEntity = vi.fn(async () => authorityReceipt('update'));
    await jsonReq(appFor({ getPlanEntity, updatePlanEntity }), '/api/v1/plan/entity/ple_1', 'PATCH', { parent_id: null });
    expect(updatePlanEntity).toHaveBeenCalledWith(
      entity, { parent_id: null }, 'op', expect.objectContaining({ route: 'PATCH /api/v1/plan/entity/ple_1' }),
    );
  });
});

describe('DELETE /plan/entity/:id', () => {
  it('200 — soft-deletes; getPlanEntity tenancy-check then softDeletePlanEntity(id, actor)', async () => {
    const getPlanEntity = vi.fn(async () => entity);
    const softDeletePlanEntity = vi.fn(async () => authorityReceipt('delete'));
    const res = await appFor({ getPlanEntity, softDeletePlanEntity }).request('/api/v1/plan/entity/ple_1', {
      method: 'DELETE', headers: { 'Idempotency-Key': 'test:delete:ple_1' },
    }, ON);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(authorityReceipt('delete'));
    expect(softDeletePlanEntity).toHaveBeenCalledWith(
      entity, 'op', expect.objectContaining({ key: 'test:delete:ple_1', route: 'DELETE /api/v1/plan/entity/ple_1' }),
    );
  });

  it('404 — tenancy: entity not in caller workspace; softDeletePlanEntity never called', async () => {
    const getPlanEntity = vi.fn(async () => null);
    const softDeletePlanEntity = vi.fn();
    const res = await appFor({ getPlanEntity, softDeletePlanEntity }).request('/api/v1/plan/entity/ple_x', {
      method: 'DELETE', headers: { 'Idempotency-Key': 'test:delete:missing' },
    }, ON);
    expect(res.status).toBe(404);
    expect(softDeletePlanEntity).not.toHaveBeenCalled();
  });
});
