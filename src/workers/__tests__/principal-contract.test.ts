// principal-contract.test.ts · R41.0 · validate emitted principal against
// the public-safe xcp-platform identity contract helper shape.
//
// If our buildPrincipal output is shape-correct, the local contract mirror
// returns the expected decisions. If any field is wrong, a helper returns the
// wrong answer.

import { describe, it, expect } from 'vitest';
import {
  evaluateAppAccess,
  hasActiveAppEntitlement,
  findAppEntitlement,
  xlooopAccessDoesNotGrantXcp,
} from '../dal/types/xcp-identity-contracts';
import { buildPrincipal } from '../dal/principal-adapter';

function maratPrincipal() {
  return buildPrincipal({
    clerkUserId: 'user_3EG6hekj2J4VdVjH7RQrinrmTwi',
    clerkOrgId: 'org_3EG82VEzc8t3t65XSZ0YDlcaDMI',
    email: 'marat@xlooop.com',
    displayName: 'Marat',
    workspaceName: 'Xlooop + XCP',
    workspaceSlug: 'xlooop-xcp',
    workspaceRole: 'owner',
    // Now-relative so the active-session fixture never time-rots. Was hardcoded
    // 2026-05-26T20:01Z, which expired → evaluateAppAccess returned session_expired
    // and the entitlement-contract assertions failed (260531 fix).
    sessionIssuedAt: new Date(Date.now() - 60_000).toISOString(),
    sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

describe('Canonical helper contract conformance', () => {
  it('evaluateAppAccess(xlooop, operator) → allowed + active_entitlement', () => {
    const principal = maratPrincipal();
    const decision = evaluateAppAccess(principal, 'xlooop', 'operator');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('active_entitlement');
    expect(decision.app_id).toBe('xlooop');
    expect(decision.requested_mode).toBe('operator');
  });

  it('evaluateAppAccess(xlooop, watch) → allowed', () => {
    const principal = maratPrincipal();
    const decision = evaluateAppAccess(principal, 'xlooop', 'watch');
    expect(decision.allowed).toBe(true);
  });

  it('evaluateAppAccess(xcp, watch) → missing_entitlement (R41 emits xlooop only)', () => {
    const principal = maratPrincipal();
    const decision = evaluateAppAccess(principal, 'xcp', 'watch');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('missing_entitlement');
  });

  it('hasActiveAppEntitlement(xlooop) → true', () => {
    expect(hasActiveAppEntitlement(maratPrincipal(), 'xlooop')).toBe(true);
  });

  it('hasActiveAppEntitlement(xcp) → false', () => {
    expect(hasActiveAppEntitlement(maratPrincipal(), 'xcp')).toBe(false);
  });

  it('findAppEntitlement(xlooop) returns the entitlement', () => {
    const entitlement = findAppEntitlement(maratPrincipal(), 'xlooop');
    expect(entitlement).toBeDefined();
    expect(entitlement!.app_id).toBe('xlooop');
    expect(entitlement!.status).toBe('active');
  });

  it('findAppEntitlement(xcp) returns undefined', () => {
    expect(findAppEntitlement(maratPrincipal(), 'xcp')).toBeUndefined();
  });

  it('xlooopAccessDoesNotGrantXcp(principal) → true (the core rule)', () => {
    expect(xlooopAccessDoesNotGrantXcp(maratPrincipal())).toBe(true);
  });

  it('viewer role denied operator-mode access', () => {
    const principal = buildPrincipal({
      clerkUserId: 'user_viewer',
      clerkOrgId: 'org_viewer',
      email: 'viewer@example.com',
      displayName: 'Viewer',
      workspaceName: 'Viewer Org',
      workspaceSlug: 'viewer-org',
      workspaceRole: 'viewer',
      sessionIssuedAt: '2026-05-26T20:00:00.000Z',
      sessionExpiresAt: null,
    });
    const decision = evaluateAppAccess(principal, 'xlooop', 'operator');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('mode_not_allowed');
  });

  it('viewer role allowed watch-mode access', () => {
    const principal = buildPrincipal({
      clerkUserId: 'user_viewer2',
      clerkOrgId: 'org_viewer2',
      email: 'viewer2@example.com',
      displayName: 'Viewer2',
      workspaceName: 'Viewer Org',
      workspaceSlug: 'viewer-org',
      workspaceRole: 'viewer',
      sessionIssuedAt: '2026-05-26T20:00:00.000Z',
      sessionExpiresAt: null,
    });
    const decision = evaluateAppAccess(principal, 'xlooop', 'watch');
    expect(decision.allowed).toBe(true);
  });
});
