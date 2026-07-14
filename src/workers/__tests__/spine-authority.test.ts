// spine-authority.test.ts · OA cutover (260708) · proves the flag-gated governed-write gate.
// THE SAFETY PROOF: with ENTITLEMENT_ENFORCEMENT off (default), authorizeSpineWrite is BYTE-IDENTICAL to the
// legacy canWrite(role) — same allow/deny for every role AND no DB read (getOperatingMode/resolvePrincipal
// are never called). So flipping the flag is the ONLY thing that changes production authority. With the flag
// on, authority = entitlement + mode + action (canActOnSpine): operator-mode required, deny-wins, fail-closed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolvePrincipal is the only DB-touching dependency of the enforcement path — mock it so we can inject a
// principal with a chosen entitlement without a real database.
vi.mock('../dal/principal-hydration', () => ({ resolvePrincipal: vi.fn() }));
import { resolvePrincipal } from '../dal/principal-hydration';
import { authorizeSpineWrite, authorizeGovernedWrite, projectSpineAuthority, SPINE_ACTIONS } from '../lib/spine-authority';
import { canWrite } from '../lib/permissions';

type Auth = { role?: string; user_id?: string; workspace_id?: string; service_principal?: string };
function makeCtx(auth: Auth, env: Record<string, unknown>, dal?: unknown) {
  return { get: (k: string) => (k === 'auth' ? auth : k === 'dal' ? dal : undefined), env } as never;
}
function principal(allowed_modes: string[], allowed_actions: string[], denied_actions: string[], expired = false) {
  const now = Date.now();
  return {
    schema_version: 'xcp.authenticated_principal.v1',
    identity_id: 'u', actor_id: 'u', email: null, display_name: 'u', identity_source: 'oidc',
    tenant_id: 'w', owner_graph_id: 'owner-graph:w', memberships: [], permissions: [],
    session_issued_at: new Date(now - 60_000).toISOString(),
    session_expires_at: new Date(now + (expired ? -1000 : 3_600_000)).toISOString(),
    assurance_level: 'medium',
    app_entitlements: [{
      app_id: 'xlooop', status: 'active', enabled_by: 'test', authority_ref: 't', risk_lane: 'test',
      expires_at: null, review_due: null, allowed_modes, allowed_actions, denied_actions,
    }],
  };
}

beforeEach(() => vi.clearAllMocks());

describe('authorizeSpineWrite · flag OFF (default) == legacy canWrite, no DB touch', () => {
  it.each(['owner', 'operator', 'viewer', 'client', undefined])('role=%s matches canWrite exactly', async (role) => {
    const dal = { getOperatingMode: vi.fn() };
    const ctx = makeCtx({ role, user_id: 'u', workspace_id: 'w' }, { ENTITLEMENT_ENFORCEMENT: 'off' }, dal);
    const d = await authorizeSpineWrite(ctx, 'evidence:submit');
    expect(d.allowed).toBe(canWrite(role)); // owner/operator → true; viewer/client/undefined → false
    expect(dal.getOperatingMode).not.toHaveBeenCalled(); // no DB read on the legacy path
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it('an ABSENT flag defaults to off (legacy)', async () => {
    const ctx = makeCtx({ role: 'operator', user_id: 'u', workspace_id: 'w' }, {}, { getOperatingMode: vi.fn() });
    expect((await authorizeSpineWrite(ctx, 'packet:create')).allowed).toBe(true);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });
});

describe('authorizeSpineWrite · flag ON == entitlement + mode + action', () => {
  const ENV = { ENTITLEMENT_ENFORCEMENT: 'on', DATABASE_URL: 'postgres://fake@h/d' };
  function ctxFor(mode: 'watch' | 'test' | 'operator', p: ReturnType<typeof principal> | null) {
    (resolvePrincipal as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      p ?? { app_entitlements: [], session_expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    );
    const dal = { getOperatingMode: vi.fn(async () => mode) };
    return makeCtx({ role: 'operator', user_id: 'u', workspace_id: 'w' }, ENV, dal);
  }

  it('operator mode + operator entitlement + action allowed → allowed', async () => {
    const d = await authorizeSpineWrite(ctxFor('operator', principal(['watch', 'test', 'operator'], ['*'], [])), 'evidence:submit');
    expect(d.allowed).toBe(true);
  });

  it('watch mode → denied (mode_requires_operator) regardless of entitlement', async () => {
    const d = await authorizeSpineWrite(ctxFor('watch', principal(['watch', 'test', 'operator'], ['*'], [])), 'evidence:submit');
    expect(d).toEqual({ allowed: false, reason: 'mode_requires_operator' });
  });

  it('operator mode but NO entitlement row → fail closed (missing_entitlement)', async () => {
    const d = await authorizeSpineWrite(ctxFor('operator', null), 'evidence:submit');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('missing_entitlement');
  });

  it('denied_actions overrides allowed_actions wildcard (deny wins)', async () => {
    const d = await authorizeSpineWrite(ctxFor('operator', principal(['watch', 'test', 'operator'], ['*'], ['evidence:submit'])), 'evidence:submit');
    expect(d).toEqual({ allowed: false, reason: 'action_denied' });
  });

  it('operator mode but allowed_modes excludes operator → mode_not_allowed', async () => {
    const d = await authorizeSpineWrite(ctxFor('operator', principal(['watch'], [], [])), 'evidence:submit');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('mode_not_allowed');
  });
});

// The third lockout vector (dev-team Ask 1): canary_lifecycle + customer_token service tokens have NO
// customer_entitlements row and NO user_session_preferences mode, so the flag-ON enforcement path would 403
// EVERY machine write at flip (the 055/056 human backfills can't touch svc_* ids). They are exempt: authority
// stays the legacy role gate in BOTH flag states, narrowed by their downstream scope guard. This proves the
// exemption is behaviour-preserving under the flag AND does NOT touch the DB (no lockout surface).
describe('authorizeSpineWrite · service principals exempt from enforcement (flag ON)', () => {
  const ON = { ENTITLEMENT_ENFORCEMENT: 'on', DATABASE_URL: 'postgres://fake@h/d' };
  it('canary_lifecycle (operator) → allowed via legacy gate, NO DB touch even flag-on', async () => {
    const dal = { getOperatingMode: vi.fn() };
    const ctx = makeCtx({ role: 'operator', user_id: 'svc_xlooop_canary_lifecycle', workspace_id: 'w', service_principal: 'canary_lifecycle' }, ON, dal);
    const d = await authorizeSpineWrite(ctx, 'evidence:submit');
    expect(d).toEqual({ allowed: true, reason: 'active_entitlement' });
    expect(dal.getOperatingMode).not.toHaveBeenCalled();
    expect(resolvePrincipal).not.toHaveBeenCalled(); // exempt → never reaches the entitlement read
  });
  it('customer_token (operator) → allowed via legacy gate, NO DB touch even flag-on', async () => {
    const dal = { getOperatingMode: vi.fn() };
    const ctx = makeCtx({ role: 'operator', user_id: 'svc_customer_abc', workspace_id: 'w', service_principal: 'customer_token' }, ON, dal);
    const d = await authorizeSpineWrite(ctx, 'tool_event:report');
    expect(d.allowed).toBe(true);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });
  it('canary_read (viewer) → still DENIED (exemption keeps the role gate, does not widen authority)', async () => {
    const dal = { getOperatingMode: vi.fn() };
    const ctx = makeCtx({ role: 'viewer', user_id: 'svc_xlooop_canary', workspace_id: 'w', service_principal: 'canary_read' }, ON, dal);
    const d = await authorizeSpineWrite(ctx, 'evidence:submit');
    expect(d.allowed).toBe(false);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });
  it('a HUMAN operator (no service_principal) still goes through enforcement (resolvePrincipal called)', async () => {
    (resolvePrincipal as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['*'], []));
    const dal = { getOperatingMode: vi.fn(async () => 'operator' as const) };
    const ctx = makeCtx({ role: 'operator', user_id: 'u', workspace_id: 'w' }, ON, dal);
    await authorizeSpineWrite(ctx, 'evidence:submit');
    expect(resolvePrincipal).toHaveBeenCalledTimes(1); // contrast: humans are NOT exempt
  });
});

// P5(b) · authorizeGovernedWrite — the inline-gate migration wrapper. Each legacy predicate class must be
// reproduced BYTE-IDENTICALLY flag-off: Class A (canWrite-equivalent), Class B (owner/operator OR is_admin,
// service principals DENIED in both states).
describe('authorizeGovernedWrite · legacy-class fidelity', () => {
  const OFF = { ENTITLEMENT_ENFORCEMENT: 'off' };
  const ON = { ENTITLEMENT_ENFORCEMENT: 'on', DATABASE_URL: 'postgres://fake@h/d' };

  it('Class A flag-off == canWrite for every role (no DB read)', async () => {
    for (const role of ['owner', 'operator', 'viewer', 'client', undefined]) {
      const dal = { getOperatingMode: vi.fn() };
      const ctx = makeCtx({ role, user_id: 'u', workspace_id: 'w' }, OFF, dal);
      const d = await authorizeGovernedWrite(ctx, 'authority:revoke');
      expect(d.allowed).toBe(canWrite(role));
      expect(dal.getOperatingMode).not.toHaveBeenCalled();
    }
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it('Class B flag-off: is_admin passes, service principal DENIED (canAdminMutate byte-identity)', async () => {
    const admin = makeCtx({ role: 'viewer', user_id: 'a', workspace_id: 'w', is_admin: true } as never, OFF);
    expect((await authorizeGovernedWrite(admin, 'policy:write', { adminOverride: true, denyServicePrincipals: true })).allowed).toBe(true);
    const sp = makeCtx({ role: 'operator', user_id: 'svc', workspace_id: 'w', service_principal: 'canary_lifecycle' }, OFF);
    expect((await authorizeGovernedWrite(sp, 'policy:write', { adminOverride: true, denyServicePrincipals: true })).allowed).toBe(false);
    const owner = makeCtx({ role: 'owner', user_id: 'o', workspace_id: 'w' }, OFF);
    expect((await authorizeGovernedWrite(owner, 'policy:write', { adminOverride: true, denyServicePrincipals: true })).allowed).toBe(true);
  });

  it('Class B flag-ON: admin overlay still passes (platform admin is not a workspace member); SP still denied', async () => {
    const admin = makeCtx({ role: 'viewer', user_id: 'a', workspace_id: 'w', is_admin: true } as never, ON, { getOperatingMode: vi.fn() });
    expect((await authorizeGovernedWrite(admin, 'policy:write', { adminOverride: true, denyServicePrincipals: true })).allowed).toBe(true);
    expect(resolvePrincipal).not.toHaveBeenCalled(); // overlay short-circuits before the entitlement read
    const sp = makeCtx({ role: 'operator', user_id: 'svc', workspace_id: 'w', service_principal: 'customer_token' }, ON);
    expect((await authorizeGovernedWrite(sp, 'policy:write', { adminOverride: true, denyServicePrincipals: true })).allowed).toBe(false);
  });

  it('flag-ON: a governed action goes through canActOnSpine (denied_actions can revoke it individually)', async () => {
    (resolvePrincipal as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['*'], ['token:create']));
    const ctx = makeCtx({ role: 'owner', user_id: 'u', workspace_id: 'w' }, ON, { getOperatingMode: vi.fn(async () => 'operator' as const) });
    expect((await authorizeGovernedWrite(ctx, 'token:create')).allowed).toBe(false); // deny wins
    expect((await authorizeGovernedWrite(ctx, 'signoff:decide')).allowed).toBe(true); // wildcard grants the rest
  });
});

// B1 · the READ projection the UI consumes. It must return the SAME verdict the write gate enforces, per
// action, so an enabled control can never 403 (nor a hidden one silently succeed) — in EITHER flag state.
describe('projectSpineAuthority · affordance projection == enforcement', () => {
  it('flag OFF operator → every action allowed, enforced:false, NO DB read', async () => {
    const dal = { getOperatingMode: vi.fn() };
    const ctx = makeCtx({ role: 'operator', user_id: 'u', workspace_id: 'w' }, { ENTITLEMENT_ENFORCEMENT: 'off' }, dal);
    const env = await projectSpineAuthority(ctx);
    expect(env.enforced).toBe(false);
    expect(env.allowed_actions.length).toBe(SPINE_ACTIONS.length);
    expect(env.disabled_reasons).toEqual({});
    expect(dal.getOperatingMode).not.toHaveBeenCalled();
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it('flag OFF viewer → every action disabled (mode_not_allowed), enforced:false', async () => {
    const ctx = makeCtx({ role: 'viewer', user_id: 'v', workspace_id: 'w' }, { ENTITLEMENT_ENFORCEMENT: 'off' }, { getOperatingMode: vi.fn() });
    const env = await projectSpineAuthority(ctx);
    expect(env.allowed_actions).toEqual([]);
    expect(Object.keys(env.disabled_reasons).length).toBe(SPINE_ACTIONS.length);
    expect(env.disabled_reasons['evidence:submit']).toBe('mode_not_allowed');
  });

  it('flag ON operator + entitlement granting a SUBSET → allowed_actions == that subset, enforced:true', async () => {
    (resolvePrincipal as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['evidence:submit', 'packet:create'], []));
    const ctx = makeCtx({ role: 'operator', user_id: 'u', workspace_id: 'w' }, { ENTITLEMENT_ENFORCEMENT: 'on', DATABASE_URL: 'postgres://fake@h/d' }, { getOperatingMode: vi.fn(async () => 'operator' as const) });
    const env = await projectSpineAuthority(ctx);
    expect(env.enforced).toBe(true);
    expect([...env.allowed_actions].sort()).toEqual(['evidence:submit', 'packet:create'].sort());
    expect(env.disabled_reasons['approval:decide']).toBe('action_not_allowed');
  });

  it('flag ON watch → every action disabled (mode_requires_operator) — the honest "Watch blocks writes"', async () => {
    (resolvePrincipal as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['*'], []));
    const ctx = makeCtx({ role: 'operator', user_id: 'u', workspace_id: 'w' }, { ENTITLEMENT_ENFORCEMENT: 'on', DATABASE_URL: 'postgres://fake@h/d' }, { getOperatingMode: vi.fn(async () => 'watch' as const) });
    const env = await projectSpineAuthority(ctx);
    expect(env.allowed_actions).toEqual([]);
    expect(env.disabled_reasons['evidence:submit']).toBe('mode_requires_operator');
  });

  it('CONSISTENCY GATE: projection allow(action) === authorizeSpineWrite(action).allowed, for EVERY action', async () => {
    (resolvePrincipal as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(principal(['watch', 'test', 'operator'], ['evidence:submit'], ['packet:create']));
    const mk = () => makeCtx({ role: 'operator', user_id: 'u', workspace_id: 'w' }, { ENTITLEMENT_ENFORCEMENT: 'on', DATABASE_URL: 'postgres://fake@h/d' }, { getOperatingMode: async () => 'operator' as const });
    const env = await projectSpineAuthority(mk());
    for (const a of SPINE_ACTIONS) {
      const enforced = await authorizeSpineWrite(mk(), a);
      expect(env.allowed_actions.includes(a)).toBe(enforced.allowed); // affordance == enforcement, per action
    }
  });
});
