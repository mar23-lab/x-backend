// permissions-operator-axis.test.ts · Wave OA-SAFE (260708) · APPLIED + LIVE (adapted from the frontend-team
// handoff bundle). Proves the tightened operator-axis authority (canActOnSpine) against the PURE helper — no
// route plumbing needed. The route-level equivalents live, skipped, in operator-axis-route-contract.test.ts.
// ─────────────────────────────────────────────────────────────────────────────
//
// These assert the 12 required cases against the PURE canonical helper, so they need NO
// route plumbing and would pass as soon as permissions.proposed.ts is applied. The
// route-level equivalents (which DO need middleware plumbing) live, skipped, in
// operator-axis-route-contract.test.ts.

import { describe, it, expect } from 'vitest';
import { canActOnSpine, canWrite } from '../lib/permissions';
import type {
  AuthenticatedPrincipal,
  AppEntitlement,
  MembershipRole,
  IdentitySource,
} from '../dal/types/xcp-identity-contracts';

// Build a principal whose xlooop entitlement / identity we can vary. The MembershipRole
// LABEL is deliberately a free knob here — the whole point is that it is NOT authority.
function mkPrincipal(opts: {
  label?: MembershipRole;
  source?: IdentitySource;
  ent?: Partial<AppEntitlement>;
  sessionExpiresAt?: string | null;
}): AuthenticatedPrincipal {
  const entitlement: AppEntitlement = {
    app_id: 'xlooop',
    status: 'active',
    enabled_by: 'test',
    authority_ref: 'test',
    risk_lane: 'test',
    expires_at: null,
    review_due: null,
    allowed_modes: ['watch', 'test', 'operator'],
    allowed_actions: ['*'],
    denied_actions: [],
    ...opts.ent,
  };
  return {
    schema_version: 'xcp.authenticated_principal.v1',
    identity_id: 'id_test',
    actor_id: 'actor_test',
    email: 'test@example.com',
    display_name: 'Test Actor',
    identity_source: opts.source ?? 'oidc',
    tenant_id: 't1',
    owner_graph_id: 'g1',
    memberships: [
      { tenant_id: 't1', workspace_id: 'w1', role: opts.label ?? 'Owner', permissions: [] },
    ],
    app_entitlements: [entitlement],
    permissions: [],
    session_issued_at: '2000-01-01T00:00:00.000Z',
    session_expires_at: opts.sessionExpiresAt === undefined ? null : opts.sessionExpiresAt,
    assurance_level: 'high',
  };
}

const NOW = new Date('2026-06-01T00:00:00.000Z');

describe('operator-axis · canActOnSpine — authority is entitlement+mode+action, not a role string', () => {
  // 1) Owner with valid entitlement + operator mode allowed CAN write.
  it('owner + active entitlement + operator mode → allowed', () => {
    const p = mkPrincipal({ label: 'Owner' });
    expect(canActOnSpine(p, 'xlooop', 'operator', 'evidence:submit', NOW).allowed).toBe(true);
  });

  // 2) A DIFFERENT role label with the SAME valid entitlement CAN write — proving the
  //    label is not the authority (Admin here; could be any label).
  it('admin label + identical entitlement → allowed (label is not authority)', () => {
    const p = mkPrincipal({ label: 'Admin' });
    expect(canActOnSpine(p, 'xlooop', 'operator', 'approval:decide', NOW).allowed).toBe(true);
  });

  // 3) THE MONEY CASE: a principal WITH a role label but WITHOUT operator in allowed_modes
  //    CANNOT write, even though a legacy role-string gate might have let 'operator' through.
  it('label present but operator NOT in allowed_modes → denied (mode_not_allowed)', () => {
    const p = mkPrincipal({ label: 'Owner', ent: { allowed_modes: ['watch', 'test'] } });
    const d = canActOnSpine(p, 'xlooop', 'operator', 'packet:create', NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('mode_not_allowed');
  });

  // 4) Viewer-class principal (no operator entitlement) cannot write.
  it('viewer-class (operator mode not entitled) → denied', () => {
    const p = mkPrincipal({ label: 'Viewer', ent: { allowed_modes: ['watch'], allowed_actions: ['workspace:read'] } });
    expect(canActOnSpine(p, 'xlooop', 'operator', 'evidence:submit', NOW).allowed).toBe(false);
  });

  // 5) Client / signed-url reviewer cannot perform an internal write.
  it('signed_url client (denied_actions:[*]) → denied (action_denied)', () => {
    const p = mkPrincipal({
      label: 'Client',
      source: 'signed_url',
      ent: { allowed_modes: ['watch'], allowed_actions: [], denied_actions: ['*'] },
    });
    const d = canActOnSpine(p, 'xlooop', 'operator', 'approval:request', NOW);
    expect(d.allowed).toBe(false);
    // operator not in allowed_modes → mode_not_allowed (deny is reached before action list here)
    expect(d.reason).toBe('mode_not_allowed');
  });

  // 6) Expired entitlement cannot write.
  it('expired entitlement (status=expired) → denied (entitlement_not_active)', () => {
    const p = mkPrincipal({ ent: { status: 'expired' } });
    const d = canActOnSpine(p, 'xlooop', 'operator', 'evidence:submit', NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('entitlement_not_active');
  });

  // 6b) Expired SESSION cannot write (independent of entitlement status).
  it('expired session → denied (session_expired)', () => {
    const p = mkPrincipal({ sessionExpiresAt: '2020-01-01T00:00:00.000Z' });
    const d = canActOnSpine(p, 'xlooop', 'operator', 'evidence:submit', NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('session_expired');
  });

  // 7) Suspended/inactive (disabled|revoked) entitlement cannot write.
  it('revoked entitlement → denied (entitlement_not_active)', () => {
    const p = mkPrincipal({ ent: { status: 'revoked' } });
    expect(canActOnSpine(p, 'xlooop', 'operator', 'packet:create', NOW).reason).toBe('entitlement_not_active');
  });

  // 8) denied_actions override allowed_actions (deny wins) even with wildcard allow.
  it('allowed_actions:[*] but denied_actions:[evidence:submit] → denied (action_denied)', () => {
    const p = mkPrincipal({ ent: { allowed_actions: ['*'], denied_actions: ['evidence:submit'] } });
    const d = canActOnSpine(p, 'xlooop', 'operator', 'evidence:submit', NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('action_denied');
    // a DIFFERENT action on the same principal is still allowed:
    expect(canActOnSpine(p, 'xlooop', 'operator', 'packet:create', NOW).allowed).toBe(true);
  });

  // 9) watch mode cannot perform an operator write.
  it('watch mode → denied (mode_requires_operator)', () => {
    const p = mkPrincipal({});
    const d = canActOnSpine(p, 'xlooop', 'watch', 'evidence:submit', NOW);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('mode_requires_operator');
  });

  // 10) test mode cannot perform a governed/production write by default.
  it('test mode → denied (mode_requires_operator)', () => {
    const p = mkPrincipal({});
    expect(canActOnSpine(p, 'xlooop', 'test', 'metric_delta:record', NOW).reason).toBe('mode_requires_operator');
  });

  // 11) service-token / API actor follows service IDENTITY via the SAME entitlement path —
  //     no role bypass. Entitled service → allowed; de-entitled service → denied.
  it('service_token actor routes through entitlement (no role bypass)', () => {
    const entitled = mkPrincipal({ label: 'Service', source: 'service_token' });
    expect(canActOnSpine(entitled, 'xlooop', 'operator', 'tool_event:report', NOW).allowed).toBe(true);
    const deEntitled = mkPrincipal({
      label: 'Service',
      source: 'service_token',
      ent: { denied_actions: ['*'] },
    });
    expect(canActOnSpine(deEntitled, 'xlooop', 'operator', 'tool_event:report', NOW).allowed).toBe(false);
  });

  // 12) Non-regression: the legacy shim is unchanged, so the existing permissions.test.ts
  //     stays green. (Documents that the tightening is ADDITIVE, not a behaviour change to
  //     the legacy gate.)
  it('legacy canWrite() behaviour is preserved (owner/operator true; viewer/client false)', () => {
    expect(canWrite('owner')).toBe(true);
    expect(canWrite('operator')).toBe(true);
    expect(canWrite('viewer')).toBe(false);
    expect(canWrite('client')).toBe(false);
  });
});
