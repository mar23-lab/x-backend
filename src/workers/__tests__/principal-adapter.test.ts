// principal-adapter.test.ts · R41.0 · unit tests for the R40→canonical shim
//
// Verifies field-by-field that buildPrincipal() produces the canonical
// AuthenticatedPrincipal v1 shape from a R40-flavored input.

import { describe, it, expect } from 'vitest';
import { buildPrincipal, mapRole, modesForRole, permissionsForRole } from '../dal/principal-adapter';

describe('mapRole', () => {
  it('owner → Owner', () => expect(mapRole('owner')).toBe('Owner'));
  it('operator → Admin', () => expect(mapRole('operator')).toBe('Admin'));
  it('viewer → Viewer', () => expect(mapRole('viewer')).toBe('Viewer'));
  it('client → Client', () => expect(mapRole('client')).toBe('Client'));
});

describe('modesForRole', () => {
  it('owner gets full modes', () => expect(modesForRole('owner')).toEqual(['watch', 'test', 'operator']));
  it('operator gets full modes', () => expect(modesForRole('operator')).toEqual(['watch', 'test', 'operator']));
  it('viewer is watch-only', () => expect(modesForRole('viewer')).toEqual(['watch']));
  it('client is watch-only', () => expect(modesForRole('client')).toEqual(['watch']));
});

describe('permissionsForRole', () => {
  it('owner has admin:write', () => expect(permissionsForRole('owner')).toContain('admin:write'));
  it('operator has admin:read but NOT admin:write', () => {
    const perms = permissionsForRole('operator');
    expect(perms).toContain('admin:read');
    expect(perms).not.toContain('admin:write');
  });
  it('viewer is read-only', () => {
    const perms = permissionsForRole('viewer');
    expect(perms).toContain('event:read');
    expect(perms).not.toContain('event:write');
  });
  it('client gets only event:read', () => expect(permissionsForRole('client')).toEqual(['event:read']));
});

describe('buildPrincipal', () => {
  function maratFixture() {
    return {
      clerkUserId: 'user_3EG6hekj2J4VdVjH7RQrinrmTwi',
      clerkOrgId: 'org_3EG82VEzc8t3t65XSZ0YDlcaDMI',
      email: 'marat@xlooop.com',
      displayName: 'Marat',
      workspaceName: 'Xlooop + XCP',
      workspaceSlug: 'xlooop-xcp',
      workspaceRole: 'owner' as const,
      // Now-relative so the active-session fixture never time-rots (260531 fix).
      sessionIssuedAt: new Date(Date.now() - 60_000).toISOString(),
      sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  }

  it('emits the canonical schema_version', () => {
    const p = buildPrincipal(maratFixture());
    expect(p.schema_version).toBe('xcp.authenticated_principal.v1');
  });

  it('identity_id and actor_id are both the Clerk sub', () => {
    const p = buildPrincipal(maratFixture());
    expect(p.identity_id).toBe('user_3EG6hekj2J4VdVjH7RQrinrmTwi');
    expect(p.actor_id).toBe('user_3EG6hekj2J4VdVjH7RQrinrmTwi');
  });

  it('identity_source defaults to oidc', () => {
    const p = buildPrincipal(maratFixture());
    expect(p.identity_source).toBe('oidc');
  });

  it('tenant_id matches the Clerk org_id', () => {
    const p = buildPrincipal(maratFixture());
    expect(p.tenant_id).toBe('org_3EG82VEzc8t3t65XSZ0YDlcaDMI');
  });

  it('owner_graph_id is the synthetic stable proxy', () => {
    const p = buildPrincipal(maratFixture());
    expect(p.owner_graph_id).toBe('owner-graph:org_3EG82VEzc8t3t65XSZ0YDlcaDMI');
  });

  it('memberships has exactly one entry mapped to canonical 10-value role', () => {
    const p = buildPrincipal(maratFixture());
    expect(p.memberships).toHaveLength(1);
    expect(p.memberships[0]!.role).toBe('Owner');
    expect(p.memberships[0]!.tenant_id).toBe('org_3EG82VEzc8t3t65XSZ0YDlcaDMI');
    expect(p.memberships[0]!.workspace_id).toBe('org_3EG82VEzc8t3t65XSZ0YDlcaDMI');
    expect(p.memberships[0]!.permissions).toContain('admin:write');
  });

  it('app_entitlements has EXACTLY one entry for xlooop · no XCP', () => {
    const p = buildPrincipal(maratFixture());
    expect(p.app_entitlements).toHaveLength(1);
    expect(p.app_entitlements[0]!.app_id).toBe('xlooop');
    expect(p.app_entitlements[0]!.status).toBe('active');
    expect(p.app_entitlements.find(e => e.app_id === 'xcp')).toBeUndefined();
  });

  it('app_entitlements[0] has full mode set for owner role', () => {
    const p = buildPrincipal(maratFixture());
    expect(p.app_entitlements[0]!.allowed_modes).toEqual(['watch', 'test', 'operator']);
    expect(p.app_entitlements[0]!.allowed_actions).toEqual(['*']);
    expect(p.app_entitlements[0]!.denied_actions).toEqual([]);
  });

  it('assurance_level is medium', () => {
    const p = buildPrincipal(maratFixture());
    expect(p.assurance_level).toBe('medium');
  });

  it('display_name falls back to email-local-part when missing', () => {
    const p = buildPrincipal({ ...maratFixture(), displayName: '' });
    expect(p.display_name).toBe('marat');
  });

  it('display_name falls back to Unknown User when email + name both missing', () => {
    const p = buildPrincipal({ ...maratFixture(), displayName: '', email: null });
    expect(p.display_name).toBe('Unknown User');
  });

  it('viewer role produces watch-only entitlement', () => {
    const p = buildPrincipal({ ...maratFixture(), workspaceRole: 'viewer' });
    expect(p.app_entitlements[0]!.allowed_modes).toEqual(['watch']);
    expect(p.memberships[0]!.role).toBe('Viewer');
  });

  it('platform_roles and telemetry_scopes are omitted at R41', () => {
    const p = buildPrincipal(maratFixture());
    expect(p.platform_roles).toBeUndefined();
    expect(p.telemetry_scopes).toBeUndefined();
  });
});
