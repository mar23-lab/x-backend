// spine-authority-seeded.test.ts · B2 · flag-ON end-to-end through the REAL entitlement read path.
// Unlike spine-authority.test.ts (which mocks resolvePrincipal wholesale), this exercises the ACTUAL
// resolvePrincipal → getAppEntitlementRow → toAppEntitlement → canActOnSpine composition, mocking ONLY the Sql
// driver via ctx.get('sql'). It closes the "the mocked contract could drift from the real reader" gap: an
// owner with a seeded customer_entitlements row (055 shape) writes; a viewer with no row is denied by the real
// reader; watch mode blocks even a fully-entitled owner. This is the flag-on route-level proof the dev team asked for.

import { describe, it, expect } from 'vitest';
import { authorizeSpineWrite, projectSpineAuthority, SPINE_ACTIONS } from '../lib/spine-authority';

// neon's tagged-template Sql is called as sql(strings, ...values). getAppEntitlementRow passes
// (userId, workspaceId, appId) as the values — so vals[0] is the user_id we branch on. Return the seeded rows
// for that user, or [] (⇒ getAppEntitlementRow returns null ⇒ fail-closed).
function seededSql(rowsByUser: Record<string, Record<string, unknown>[]>) {
  return ((_strings: TemplateStringsArray, ...vals: unknown[]) =>
    Promise.resolve(rowsByUser[String(vals[0] ?? '')] ?? [])) as never;
}

// The 055 role-mirror row shape for an owner (operator-capable, all actions).
const OWNER_ROW: Record<string, unknown> = {
  id: 'e1', user_id: 'owner-u', workspace_id: 'w', app_id: 'xlooop-product',
  allowed_modes: ['watch', 'test', 'operator'], allowed_actions: ['*'], denied_actions: [],
  authority_ref: 'role-mirror', revoked_at: null, metadata: null,
  granted_at: '2026-07-08T00:00:00Z', created_at: null, updated_at: null,
};

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

function ctxFor(auth: Record<string, unknown>, sql: unknown, mode: 'watch' | 'test' | 'operator') {
  const dal = { getOperatingMode: async () => mode };
  return {
    get: (k: string) => (k === 'auth' ? auth : k === 'dal' ? dal : k === 'sql' ? sql : undefined),
    env: { ENTITLEMENT_ENFORCEMENT: 'on', DATABASE_URL: 'postgres://x' },
  } as never;
}

describe('flag-ON end-to-end through the REAL entitlement reader (seeded Sql)', () => {
  it('owner WITH a seeded entitlement + operator mode → write allowed', async () => {
    const ctx = ctxFor({ role: 'operator', user_id: 'owner-u', workspace_id: 'w', token_expires_at: FUTURE }, seededSql({ 'owner-u': [OWNER_ROW] }), 'operator');
    const d = await authorizeSpineWrite(ctx, 'evidence:submit');
    expect(d).toEqual({ allowed: true, reason: 'active_entitlement' });
  });

  it('viewer with NO entitlement row → denied (missing_entitlement) via the real reader', async () => {
    const ctx = ctxFor({ role: 'viewer', user_id: 'viewer-u', workspace_id: 'w', token_expires_at: FUTURE }, seededSql({}), 'operator');
    const d = await authorizeSpineWrite(ctx, 'evidence:submit');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('missing_entitlement');
  });

  it('owner in WATCH mode → denied (mode_requires_operator) even with the entitlement', async () => {
    const ctx = ctxFor({ role: 'operator', user_id: 'owner-u', workspace_id: 'w', token_expires_at: FUTURE }, seededSql({ 'owner-u': [OWNER_ROW] }), 'watch');
    const d = await authorizeSpineWrite(ctx, 'evidence:submit');
    expect(d.reason).toBe('mode_requires_operator');
  });

  it('projection agrees: an entitled owner in operator mode sees every action allowed', async () => {
    const ctx = ctxFor({ role: 'operator', user_id: 'owner-u', workspace_id: 'w', token_expires_at: FUTURE }, seededSql({ 'owner-u': [OWNER_ROW] }), 'operator');
    const env = await projectSpineAuthority(ctx);
    expect(env.enforced).toBe(true);
    expect(env.allowed_actions.length).toBe(SPINE_ACTIONS.length); // full vocabulary (spine + P5(b) governed)
    expect(env.disabled_reasons).toEqual({});
  });
});
