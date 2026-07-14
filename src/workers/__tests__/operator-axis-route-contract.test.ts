// operator-axis-route-contract.test.ts · OA cutover (260708) · APPLIED + LIVE.
// Drives the REAL operational-spine routes through the flag-gated authorizeSpineWrite gate, proving the
// route → gate wiring (not just the pure helper). Flag-OFF behaviour is already proven identical to legacy by
// the existing operational-spine-route.test.ts (which runs with the flag defaulted off); here we prove the
// flag-ON enforcement AND a flag-off legacy case at the route boundary. resolvePrincipal is mocked to inject
// a chosen entitlement without a live DB.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../dal/principal-hydration', () => ({ resolvePrincipal: vi.fn() }));
import { resolvePrincipal } from '../dal/principal-hydration';
import { operationalSpineRoute } from '../routes/operational-spine';

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
    createEvidenceItem: async (ws: string, actor: string, input: Record<string, unknown>) => ({ id: 'ev', workspace_id: ws, actor_user_id: actor, ...input }),
    createTaskPacket: async (ws: string, actor: string, input: Record<string, unknown>) => ({ id: 'pkt', workspace_id: ws, ...input }),
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('request_id', 't'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); await next(); });
  app.route('/', operationalSpineRoute);
  return app;
}
const ON = { ENTITLEMENT_ENFORCEMENT: 'on', DATABASE_URL: 'postgres://fake@h/d' } as never;
const OFF = { DATABASE_URL: 'postgres://fake@h/d' } as never;
const post = (app: Hono, path: string, body: unknown, env: never) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, env);

const OPERATOR = { user_id: 'u', role: 'operator', workspace_id: 'w' };
const VIEWER = { user_id: 'v', role: 'viewer', workspace_id: 'w' };

beforeEach(() => vi.clearAllMocks());

describe('operator-axis route contract (flag ON = entitlement-backed)', () => {
  it('operator mode + operator entitlement → POST /evidence passes the gate (not 403)', async () => {
    (resolvePrincipal as never as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['*'], []));
    const res = await post(appFor(OPERATOR, 'operator'), '/evidence', { kind: 'not_a_kind' }, ON);
    expect(res.status).not.toBe(403); // gate allowed → falls through to body validation (400)
  });

  it('operator LABEL but NO entitlement row → POST /evidence 403 (the money case)', async () => {
    (resolvePrincipal as never as ReturnType<typeof vi.fn>).mockResolvedValue({ app_entitlements: [], session_expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const res = await post(appFor(OPERATOR, 'operator'), '/evidence', { kind: 'log' }, ON);
    expect(res.status).toBe(403);
  });

  it('watch mode → POST /tool-events 403 (mode_requires_operator)', async () => {
    (resolvePrincipal as never as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['*'], []));
    const res = await post(appFor(OPERATOR, 'watch'), '/tool-events', { action: 'x' }, ON);
    expect(res.status).toBe(403);
  });

  it('denied_actions:[approval:request] → POST /approvals 403 even if operator-entitled', async () => {
    (resolvePrincipal as never as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['*'], ['approval:request']));
    const res = await post(appFor(OPERATOR, 'operator'), '/approvals', { reason: 'x' }, ON);
    expect(res.status).toBe(403);
  });
});

describe('operator-axis route contract (flag OFF = legacy, unchanged)', () => {
  it('viewer → POST /packets 403 via the legacy path (no resolvePrincipal call)', async () => {
    const res = await post(appFor(VIEWER, 'operator'), '/packets', { title: 't', summary: 's' }, OFF);
    expect(res.status).toBe(403);
    expect(resolvePrincipal).not.toHaveBeenCalled(); // flag off → no entitlement machinery touched
  });

  it('operator → POST /packets passes the legacy gate (not 403)', async () => {
    const res = await post(appFor(OPERATOR, 'operator'), '/packets', { title: 't', summary: 's' }, OFF);
    expect(res.status).not.toBe(403);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });
});
