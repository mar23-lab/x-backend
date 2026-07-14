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
  return app.request(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, ON);
}

describe('POST /plan/entity', () => {
  it('201 — creates an entity; DAL called with (input incl workspace_id + kind, actor)', async () => {
    const createPlanEntity = vi.fn(async () => entity);
    const res = await jsonReq(appFor({ createPlanEntity }), '/api/v1/plan/entity', 'POST', {
      scope_id: 'scope_x', scope_type: 'workspace', kind: 'goal', title: 'Ship G1',
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { entity: { id: string } };
    expect(j.entity.id).toBe('ple_1');
    expect(createPlanEntity).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 'org_a', scope_id: 'scope_x', kind: 'goal', title: 'Ship G1' }),
      'op',
    );
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
    const updatePlanEntity = vi.fn(async () => ({ ...entity, title: 'Renamed', position: 2 }));
    const res = await jsonReq(appFor({ getPlanEntity, updatePlanEntity }), '/api/v1/plan/entity/ple_1', 'PATCH', { title: 'Renamed', position: 2 });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { entity: { title: string } };
    expect(j.entity.title).toBe('Renamed');
    expect(getPlanEntity).toHaveBeenCalledWith('ple_1', 'org_a');
    expect(updatePlanEntity).toHaveBeenCalledWith('ple_1', { title: 'Renamed', position: 2 }, 'op');
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
    const updatePlanEntity = vi.fn(async () => entity);
    await jsonReq(appFor({ getPlanEntity, updatePlanEntity }), '/api/v1/plan/entity/ple_1', 'PATCH', { parent_id: null });
    expect(updatePlanEntity).toHaveBeenCalledWith('ple_1', { parent_id: null }, 'op');
  });
});

describe('DELETE /plan/entity/:id', () => {
  it('200 — soft-deletes; getPlanEntity tenancy-check then softDeletePlanEntity(id, actor)', async () => {
    const getPlanEntity = vi.fn(async () => entity);
    const softDeletePlanEntity = vi.fn(async () => undefined);
    const res = await appFor({ getPlanEntity, softDeletePlanEntity }).request('/api/v1/plan/entity/ple_1', { method: 'DELETE' }, ON);
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ deleted: { id: 'ple_1' } });
    expect(softDeletePlanEntity).toHaveBeenCalledWith('ple_1', 'op');
  });

  it('404 — tenancy: entity not in caller workspace; softDeletePlanEntity never called', async () => {
    const getPlanEntity = vi.fn(async () => null);
    const softDeletePlanEntity = vi.fn();
    const res = await appFor({ getPlanEntity, softDeletePlanEntity }).request('/api/v1/plan/entity/ple_x', { method: 'DELETE' }, ON);
    expect(res.status).toBe(404);
    expect(softDeletePlanEntity).not.toHaveBeenCalled();
  });
});
