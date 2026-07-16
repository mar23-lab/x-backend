// sources-read-policy-route.test.ts · PATCH /api/v1/sources/:id (G2 · source access tier / read_policy)
//
// Injects auth + a fake dal and asserts the route contract: read_policy OR level→policy mapping,
// ownership 404, 422 on a bad value, 409 when migration 067 hasn't applied, and DAL delegation.
// Mirrors members-role-mutation.test.ts (no DB).
//
// Authority: src/workers/routes/sources.ts + src/workers/dal/source-store.ts (setUserSourceReadPolicy)

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { sourcesRoute } from '../routes/sources';

function appFor(
  dal: Record<string, unknown>,
  auth: { user_id: string; workspace_id?: string } = { user_id: 'u1', workspace_id: 'org_a' },
) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't');
    ctx.set('auth', auth as never);
    ctx.set('dal', { ...dal, plan: dal } as never);
    await next();
  });
  app.route('/api/v1', sourcesRoute);
  return app;
}

const source = {
  id: 'usc_1', workspace_id: 'org_a', user_id: 'u1', provider: 'github',
  provider_user_id: 'gh1', provider_username: 'octocat', scopes: ['repo'],
  contract: { version: 1 }, status: 'connected', read_policy: 'metadata_only',
  connected_at: '2026-07-11T00:00:00Z', last_sync_at: null, last_sync_error: null,
  created_at: '2026-07-11T00:00:00Z', updated_at: '2026-07-11T00:00:00Z',
};
const policyReceipt = (read_policy: string) => ({
  source: { ...source, read_policy },
  read_policy_revision_id: `source-read-policy:usc_1:${read_policy}:audit_source_policy`,
  audit_event_id: 'audit_source_policy',
});

function patch(app: ReturnType<typeof appFor>, body: unknown) {
  return app.request('/api/v1/sources/usc_1', {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

describe('PATCH /sources/:id — read_policy', () => {
  it('200 — {read_policy} persisted; DAL called with (user, id, policy); response carries read_policy', async () => {
    const getUserSource = vi.fn(async () => source);
    const setUserSourceReadPolicy = vi.fn(async () => policyReceipt('read_only'));
    const upsertEvent = vi.fn(async () => undefined);
    const res = await patch(appFor({ getUserSource, setUserSourceReadPolicy, upsertEvent }), { read_policy: 'read_only' });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { source: { read_policy: string }; read_policy_revision_id: string; audit_event_id: string };
    expect(j.source.read_policy).toBe('read_only');
    expect(j.read_policy_revision_id).toBe('source-read-policy:usc_1:read_only:audit_source_policy');
    expect(j.audit_event_id).toBe('audit_source_policy');
    expect(setUserSourceReadPolicy).toHaveBeenCalledWith('u1', 'usc_1', 'read_only', 'org_a');
  });

  it('200 — UI {level:"operate"} maps to proposal_only', async () => {
    const getUserSource = vi.fn(async () => source);
    const setUserSourceReadPolicy = vi.fn(async () => policyReceipt('proposal_only'));
    const upsertEvent = vi.fn(async () => undefined);
    const res = await patch(appFor({ getUserSource, setUserSourceReadPolicy, upsertEvent }), { level: 'operate' });
    expect(res.status).toBe(200);
    expect(setUserSourceReadPolicy).toHaveBeenCalledWith('u1', 'usc_1', 'proposal_only', 'org_a');
  });

  it('200 — UI {level:"index"} maps to metadata_only, {level:"rely"} maps to read_only', async () => {
    const setUserSourceReadPolicy = vi.fn(async (_u, _id, policy) => policyReceipt(policy));
    const app = appFor({ getUserSource: vi.fn(async () => source), setUserSourceReadPolicy, upsertEvent: vi.fn() });
    await patch(app, { level: 'index' });
    await patch(app, { level: 'rely' });
    expect(setUserSourceReadPolicy).toHaveBeenNthCalledWith(1, 'u1', 'usc_1', 'metadata_only', 'org_a');
    expect(setUserSourceReadPolicy).toHaveBeenNthCalledWith(2, 'u1', 'usc_1', 'read_only', 'org_a');
  });

  it('422 — invalid value rejected before any set call', async () => {
    const getUserSource = vi.fn(async () => source);
    const setUserSourceReadPolicy = vi.fn();
    const res = await patch(appFor({ getUserSource, setUserSourceReadPolicy }), { read_policy: 'full_access' });
    expect(res.status).toBe(422);
    expect(setUserSourceReadPolicy).not.toHaveBeenCalled();
  });

  it('404 — not owned (getUserSource null); set never called', async () => {
    const getUserSource = vi.fn(async () => null);
    const setUserSourceReadPolicy = vi.fn();
    const res = await patch(appFor({ getUserSource, setUserSourceReadPolicy }), { read_policy: 'read_only' });
    expect(res.status).toBe(404);
    expect(setUserSourceReadPolicy).not.toHaveBeenCalled();
  });

  it('401 — no authenticated user', async () => {
    const res = await patch(appFor({ getUserSource: vi.fn() }, { user_id: '' }), { read_policy: 'read_only' });
    expect(res.status).toBe(401);
  });

  it('409 — store signals migration 067 not applied (READ_POLICY_UNAVAILABLE)', async () => {
    const getUserSource = vi.fn(async () => source);
    const setUserSourceReadPolicy = vi.fn(async () => {
      const e = new Error('source access-level persistence requires migration 067 to be applied') as Error & { code?: string; status?: number };
      e.code = 'READ_POLICY_UNAVAILABLE'; e.status = 409;
      throw e;
    });
    const res = await patch(appFor({ getUserSource, setUserSourceReadPolicy, upsertEvent: vi.fn() }), { read_policy: 'read_only' });
    expect(res.status).toBe(409);
  });

  it('500 — route fails closed when the DAL does not return a read-policy audit receipt', async () => {
    const getUserSource = vi.fn(async () => source);
    const setUserSourceReadPolicy = vi.fn(async () => ({ source: { ...source, read_policy: 'read_only' } }));
    const res = await patch(appFor({ getUserSource, setUserSourceReadPolicy }), { read_policy: 'read_only' });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { code?: string };
    expect(json.code).toBe('SOURCE_RECEIPT_MISSING');
  });
});
