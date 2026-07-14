// entitlement-hydration.test.ts · Wave OA-SAFE (260708) · APPLIED + LIVE. Proves entitlement-backed hydration
// (buildPrincipalFromAuthContext) + fail-closed on a missing row + no-lockout parity of the role-mirror
// backfill shape + deny-wins + revocation. The hydration path is BUILT but NOT wired into production (the
// entitlement source is empty in prod); the gap-lock (entitlement-source-gap.test.ts) still PASSES until the
// operator-gated cutover wires resolvePrincipal into buildPrincipal, at which point it flips + is retired.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { buildPrincipalFromAuthContext, buildDemoPrincipalFromRole } from '../dal/principal-hydration';
import { toAppEntitlement } from '../dal/entitlement-store';
import { canActOnSpine } from '../lib/permissions';
import type { AuthContext } from '../dal/types';
import type { AppEntitlement } from '../dal/types/xcp-identity-contracts';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function auth(role: string): AuthContext {
  return {
    user_id: `user_${role}`,
    workspace_id: 'ws1',
    role,
    auth_method: 'clerk_jwt',
    client_id: 'clerk_user',
    token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
    email: `${role}@example.com`,
  } as AuthContext;
}

// A row shaped like the 042 role-mirror backfill produces for owner/operator.
const OPERATOR_ROW = {
  allowed_modes: ['watch', 'test', 'operator'],
  allowed_actions: ['*'],
  denied_actions: [],
  authority_ref: 'backfill:042:role-mirror',
  revoked_at: null,
};
const VIEWER_ROW = { allowed_modes: ['watch'], allowed_actions: [], denied_actions: [], revoked_at: null };

describe('P0-0 · entitlement-backed hydration', () => {
  // FAIL CLOSED — the core security property.
  it('no entitlement row → app_entitlements empty → write denied (missing_entitlement)', () => {
    const p = buildPrincipalFromAuthContext(auth('owner'), null);
    expect(p.app_entitlements).toEqual([]);
    const d = canActOnSpine(p, 'xlooop', 'operator', 'evidence:submit', NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('missing_entitlement');
  });

  // NO-LOCKOUT PARITY — backfilled operator row reproduces today's write authority.
  it('role-mirror operator entitlement → operator write allowed (parity, no lockout)', () => {
    const p = buildPrincipalFromAuthContext(auth('operator'), toAppEntitlement(OPERATOR_ROW));
    expect(canActOnSpine(p, 'xlooop', 'operator', 'packet:create', NOW).allowed).toBe(true);
  });

  it('role-mirror viewer entitlement → operator write denied (mode_not_allowed)', () => {
    const p = buildPrincipalFromAuthContext(auth('viewer'), toAppEntitlement(VIEWER_ROW));
    expect(canActOnSpine(p, 'xlooop', 'operator', 'packet:create', NOW).reason).toBe('mode_not_allowed');
  });

  // THE BRANCH IS NOW LIVE — a CURATED denied_actions row actually bites (was dead under buildPrincipal).
  it('curated denied_actions bites even with operator mode (deny wins)', () => {
    const curated: AppEntitlement = toAppEntitlement({
      ...OPERATOR_ROW,
      denied_actions: ['customer_data:delete'],
    });
    const p = buildPrincipalFromAuthContext(auth('operator'), curated);
    expect(canActOnSpine(p, 'xlooop', 'operator', 'customer_data:delete', NOW).reason).toBe('action_denied');
    expect(canActOnSpine(p, 'xlooop', 'operator', 'evidence:submit', NOW).allowed).toBe(true);
  });

  // REVOCATION — revoked_at maps to status 'revoked' → denied.
  it('revoked entitlement row → status revoked → denied', () => {
    const revoked = toAppEntitlement({ ...OPERATOR_ROW, revoked_at: '2026-05-01T00:00:00.000Z' });
    expect(revoked.status).toBe('revoked');
    const p = buildPrincipalFromAuthContext(auth('operator'), revoked);
    expect(canActOnSpine(p, 'xlooop', 'operator', 'evidence:submit', NOW).reason).toBe('entitlement_not_active');
  });

  // DEV FALLBACK is explicit + cannot run in production.
  // Migration 060 · lifecycle columns are surfaced when present, null when the grant is open-ended.
  it('expires_at / review_due map through toAppEntitlement (060; Date and ISO both normalize to ISO)', () => {
    const open = toAppEntitlement(OPERATOR_ROW);
    expect(open.expires_at).toBeNull();   // no column value → open-ended grant
    expect(open.review_due).toBeNull();
    const dated = toAppEntitlement({
      ...OPERATOR_ROW,
      expires_at: new Date('2026-12-31T00:00:00.000Z'),   // pg driver may hand back a Date
      review_due: '2026-09-01T00:00:00.000Z',             // ...or an ISO string
    });
    expect(dated.expires_at).toBe('2026-12-31T00:00:00.000Z');
    expect(dated.review_due).toBe('2026-09-01T00:00:00.000Z');
    // 060 does NOT introduce expiry-based denial — status stays active while revoked_at is null.
    expect(dated.status).toBe('active');
  });

  it('buildDemoPrincipalFromRole throws unless dev fallback is explicitly enabled', () => {
    expect(() => buildDemoPrincipalFromRole(auth('owner'), { devFallbackEnabled: false })).toThrow();
    const p = buildDemoPrincipalFromRole(auth('owner'), { devFallbackEnabled: true });
    expect(p.app_entitlements[0].enabled_by).toBe('DEV_FALLBACK_role_derived');
  });
});
