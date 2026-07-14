// entitlement-source-gap.test.ts · Wave OA-SAFE (260708) · APPLIED + LIVE gap-lock.
// PASSING == the gap still exists (production buildPrincipal is still role-derived; the entitlement reader is
// BUILT but NOT wired). At the operator-gated cutover, resolvePrincipal replaces buildPrincipal → this test
// FLIPS to failing (expected) → update/retire it then. See docs/governance/OPERATOR_AXIS_AUTHORITY.md.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ THIS TEST PASSING IS THE BUG.
//
// It documents, in executable form, why wiring the routes to
// `canActOnSpine(buildPrincipal(...), 'xlooop', 'operator', action)` does NOT tighten
// authority today. `buildPrincipal()` (dal/principal-adapter.ts) FABRICATES the xlooop
// entitlement from the 4-value R40 role:
//     allowed_modes   = modesForRole(role)  → ['watch','test','operator'] iff role∈{owner,operator}
//     allowed_actions = ['*']               (hardcoded)
//     denied_actions  = []                  (hardcoded)
//     status          = 'active'            (hardcoded)
// So operator-mode reachability is a pure function of the role string — the SAME
// conflation canWrite() has, just relocated into modesForRole(). The allowed_actions /
// denied_actions / status branches of canActOnSpine() are therefore INERT (dead) under the
// current adapter: only session_expires_at can ever deny.
//
// WHEN THIS TEST STARTS FAILING, THAT IS PROGRESS: it means buildPrincipal() has been
// replaced by a REAL per-principal entitlement source (the R42 app_entitlements table the
// adapter comment anticipates), so entitlement data is no longer derived from the role.
// Update/retire this test at that point.

import { describe, it, expect } from 'vitest';
import { buildPrincipal } from '../dal/principal-adapter';
import { canActOnSpine, canWrite } from '../lib/permissions';

function principal(role: 'owner' | 'operator' | 'viewer' | 'client') {
  return buildPrincipal({
    clerkUserId: `user_${role}`,
    clerkOrgId: 'org_gap',
    email: `${role}@example.com`,
    displayName: role,
    workspaceName: 'Gap Org',
    workspaceSlug: 'gap-org',
    workspaceRole: role,
    sessionIssuedAt: new Date(Date.now() - 60_000).toISOString(),
    sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

describe('entitlement-source gap — buildPrincipal derives authority from the role (THEATER LOCK)', () => {
  it('the fabricated entitlement hardcodes actions/status (so those canActOnSpine branches are inert)', () => {
    const ent = principal('owner').app_entitlements[0];
    expect(ent.allowed_actions).toEqual(['*']); // never scoped
    expect(ent.denied_actions).toEqual([]);     // never denies
    expect(ent.status).toBe('active');          // never expired/revoked at this layer
  });

  it('operator-mode reachability equals the role check — canActOnSpine∘buildPrincipal ≡ canWrite', () => {
    for (const role of ['owner', 'operator', 'viewer', 'client'] as const) {
      const viaSpine = canActOnSpine(principal(role), 'xlooop', 'operator', 'evidence:submit').allowed;
      const viaLegacy = canWrite(role);
      // If these ever diverge, a real entitlement source has been introduced — good; update this test.
      expect(viaSpine).toBe(viaLegacy);
    }
  });

  it('viewer is denied only because modesForRole(viewer)=[watch] — NOT an independent entitlement', () => {
    const d = canActOnSpine(principal('viewer'), 'xlooop', 'operator', 'packet:create');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('mode_not_allowed'); // role-derived, not entitlement-derived
  });

  it('denied_actions cannot bite today (proves the dead branch): even a "denied" action is allowed for operator', () => {
    // There is no way to populate denied_actions via buildPrincipal, so this action is allowed
    // purely because the role grants operator mode + wildcard actions.
    expect(canActOnSpine(principal('operator'), 'xlooop', 'operator', 'customer_data:delete').allowed).toBe(true);
  });
});
