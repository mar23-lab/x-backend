// model-runtime-enforcement.test.ts · U4b (260708) · runtime config is a GOVERNED write.
// Runtime provider/default writes were role-gated only (isOperatorContext). This proves the added
// flag-ON layer: when ENTITLEMENT_ENFORCEMENT is on they ALSO obey operator mode + entitlement
// ('runtime:configure'), so a watch-mode owner can no longer reconfigure runtimes. Flag-OFF is
// byte-identical (the gate returns null before any entitlement machinery is touched).
// DECLARED AXES: actor [operator · viewer] · mode [operator · watch] · entitlement [present · absent ·
// runtime:configure denied] · flag [on · off].

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../dal/principal-hydration', () => ({ resolvePrincipal: vi.fn() }));
import { resolvePrincipal } from '../dal/principal-hydration';
import { modelRuntimesRoute } from '../routes/model-runtimes';

function principal(allowed_modes: string[], allowed_actions: string[], denied_actions: string[]) {
  const now = Date.now();
  return {
    schema_version: 'xcp.authenticated_principal.v1', identity_id: 'u', actor_id: 'u', email: null,
    display_name: 'u', identity_source: 'oidc', tenant_id: 'w', owner_graph_id: 'g', memberships: [],
    permissions: [], session_issued_at: new Date(now - 1000).toISOString(),
    session_expires_at: new Date(now + 3_600_000).toISOString(), assurance_level: 'medium',
    app_entitlements: [{
      app_id: 'xlooop', status: 'active', enabled_by: 't', authority_ref: 't', risk_lane: 't',
      expires_at: null, review_due: null, allowed_modes, allowed_actions, denied_actions,
    }],
  };
}

function appFor(auth: Record<string, unknown>, mode: 'watch' | 'test' | 'operator') {
  const dal = {
    getOperatingMode: async () => mode,
    modelRuntimes: { setDefault: async () => ({ provider: 'ollama' }) },
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('request_id', 't'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); await next(); });
  app.route('/', modelRuntimesRoute as never);
  return app;
}
const ON = { ENTITLEMENT_ENFORCEMENT: 'on', DATABASE_URL: 'postgres://fake@h/d' } as never;
const OFF = { DATABASE_URL: 'postgres://fake@h/d' } as never;
const putDefault = (app: Hono, env: never) =>
  app.request('/model-runtimes/default', { method: 'PUT', body: JSON.stringify({ provider: 'ollama' }), headers: { 'content-type': 'application/json' } }, env);

const OPERATOR = { user_id: 'u', role: 'operator', workspace_id: 'w' };
const VIEWER = { user_id: 'v', role: 'viewer', workspace_id: 'w' };

beforeEach(() => vi.clearAllMocks());

describe('runtime config · flag ON = mode + entitlement enforced', () => {
  it('operator mode + operator entitlement → gate PASSES (not 403)', async () => {
    (resolvePrincipal as never as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['*'], []));
    const res = await putDefault(appFor(OPERATOR, 'operator'), ON);
    expect(res.status).not.toBe(403);
  });

  it('WATCH mode → 403 even for an operator-role owner (the whole point of enforcement)', async () => {
    (resolvePrincipal as never as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['*'], []));
    const res = await putDefault(appFor(OPERATOR, 'watch'), ON);
    expect(res.status).toBe(403);
  });

  it('operator role but NO entitlement row → 403 (missing_entitlement)', async () => {
    (resolvePrincipal as never as ReturnType<typeof vi.fn>).mockResolvedValue({ app_entitlements: [], session_expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const res = await putDefault(appFor(OPERATOR, 'operator'), ON);
    expect(res.status).toBe(403);
  });

  it("denied_actions:['runtime:configure'] → 403 even operator-entitled (deny wins)", async () => {
    (resolvePrincipal as never as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['*'], ['runtime:configure']));
    const res = await putDefault(appFor(OPERATOR, 'operator'), ON);
    expect(res.status).toBe(403);
  });
});

describe('runtime config · flag OFF = legacy role gate, byte-identical', () => {
  it('viewer → 403 via isOperatorContext, WITHOUT touching entitlement machinery', async () => {
    const res = await putDefault(appFor(VIEWER, 'operator'), OFF);
    expect(res.status).toBe(403);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it('operator → gate PASSES (not 403), no resolvePrincipal call', async () => {
    const res = await putDefault(appFor(OPERATOR, 'watch'), OFF); // watch mode is IGNORED flag-off
    expect(res.status).not.toBe(403);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });
});
