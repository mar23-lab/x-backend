// allowed-actions.test.ts · M4 (260707) — proves the server-derived authority matrix is faithful to
// docs/security/ACCESS_CONTROL_MATRIX.md. This IS the adversarial proof: it asserts each role gets exactly
// the actions the matrix grants, that denied actions carry a reason, and that a service-principal token is
// read-only on tenant resources. A drift in allowed-actions.ts (a role gaining/losing an action) fails here.

import { describe, it, expect } from 'vitest';
import { authorityFor, withAuthority } from '../lib/allowed-actions';
import type { AuthContext } from '../dal/types/auth';

function ctx(role: AuthContext['role'], extra: Partial<AuthContext> = {}): AuthContext {
  return { user_id: 'u1', workspace_id: 'ws1', role, ...extra };
}

describe('M4 authorityFor · project resource', () => {
  it('owner may read/create/edit/archive/restore', () => {
    const a = authorityFor(ctx('owner'), 'project');
    expect(a.allowed_actions).toEqual(['read', 'create', 'edit', 'archive', 'restore']);
    expect(a.disabled_reasons).toEqual({});
  });

  it('operator matches owner on projects', () => {
    expect(authorityFor(ctx('operator'), 'project').allowed_actions)
      .toEqual(['read', 'create', 'edit', 'archive', 'restore']);
  });

  it('viewer may only read; every write carries a reason', () => {
    const a = authorityFor(ctx('viewer'), 'project');
    expect(a.allowed_actions).toEqual(['read']);
    expect(Object.keys(a.disabled_reasons).sort()).toEqual(['archive', 'create', 'edit', 'restore']);
    expect(a.disabled_reasons.create).toMatch(/owner or operator/);
  });

  it('client may take NO project action and read is explicitly denied', () => {
    const a = authorityFor(ctx('client'), 'project');
    expect(a.allowed_actions).toEqual([]);
    expect(a.disabled_reasons.read).toMatch(/client role cannot read/);
  });
});

describe('M4 authorityFor · member.role_change is owner-only', () => {
  it('owner may change roles', () => {
    expect(authorityFor(ctx('owner'), 'member').allowed_actions).toContain('role_change');
  });
  it('operator may NOT change roles (owner-only), reason present', () => {
    const a = authorityFor(ctx('operator'), 'member');
    expect(a.allowed_actions).not.toContain('role_change');
    expect(a.disabled_reasons.role_change).toMatch(/owner role/);
  });
});

// F12 fix · A-W2f dead-editor: role_change is DB-ownership-gated, but no AuthContext ever carries role
// 'owner' at runtime (Clerk org:admin→'operator'), so the pure matrix's role_change=R.ownerOnly could never
// fire and the Settings editor rendered for nobody. GET /members now computes operatorOwnsWorkspace (the
// SAME predicate the PATCH enforces) and passes { grant:['role_change'] }. These tests pin the override seam
// = the envelope↔route authority parity: the ownership boolean is the single source that drives both.
describe('F12 · member.role_change grant via ownership override (envelope↔route parity)', () => {
  it('an owning operator (grant path) IS allowed role_change and carries no disabled reason', () => {
    const a = authorityFor(ctx('operator'), 'member', { grant: ['role_change'] });
    expect(a.allowed_actions).toContain('role_change');
    expect(a.disabled_reasons.role_change).toBeUndefined();
  });
  it('a non-owning operator (no grant) is NOT allowed role_change and keeps the reason', () => {
    const a = authorityFor(ctx('operator'), 'member');
    expect(a.allowed_actions).not.toContain('role_change');
    expect(a.disabled_reasons.role_change).toMatch(/owner role/);
  });
  it('a non-owning viewer never gets role_change even with no override', () => {
    expect(authorityFor(ctx('viewer'), 'member').allowed_actions).not.toContain('role_change');
  });
  it('the override is idempotent — granting an already-allowed action does not duplicate it', () => {
    const a = authorityFor(ctx('owner'), 'member', { grant: ['role_change'] });
    expect(a.allowed_actions.filter((x) => x === 'role_change')).toHaveLength(1);
  });
  it('withAuthority forwards the override onto the payload envelope', () => {
    const env = withAuthority({ members: [] }, ctx('operator'), 'member', { grant: ['role_change'] });
    expect(env.allowed_actions).toContain('role_change');
  });
  it('HARDENING · a fabricated grant action NOT in the matrix is a no-op (cannot widen authority)', () => {
    const a = authorityFor(ctx('operator'), 'member', { grant: ['delete_everything', 'role_change'] });
    expect(a.allowed_actions).toContain('role_change');       // real matrix action → granted
    expect(a.allowed_actions).not.toContain('delete_everything'); // fabricated → skipped, never injected
    expect(a.disabled_reasons.delete_everything).toBeUndefined();
  });
});

describe('M4 authorityFor · event read is open to every member incl. client (visibility-filtered)', () => {
  it('client may read events but not write', () => {
    const a = authorityFor(ctx('client'), 'event');
    expect(a.allowed_actions).toEqual(['read']);
    expect(a.disabled_reasons.create).toMatch(/owner or operator/);
  });
});

describe('M4 authorityFor · service-principal tokens are read-only on tenant resources', () => {
  it('an operator-role customer token cannot write project sources — read-only reason cited', () => {
    const a = authorityFor(ctx('operator', { service_principal: 'customer_token' }), 'project_source');
    expect(a.allowed_actions).toEqual(['read']);
    expect(a.disabled_reasons.connect).toMatch(/service-principal tokens are read-only/);
  });
});

describe('A-W2c authorityFor · workspace resource', () => {
  it('owner/operator get the full ladder incl. create_project', () => {
    expect(authorityFor(ctx('owner'), 'workspace').allowed_actions)
      .toEqual(['read', 'create', 'edit', 'archive', 'create_project']);
    expect(authorityFor(ctx('operator'), 'workspace').allowed_actions)
      .toEqual(['read', 'create', 'edit', 'archive', 'create_project']);
  });
  it('viewer reads only; client denied with reason', () => {
    const v = authorityFor(ctx('viewer'), 'workspace');
    expect(v.allowed_actions).toEqual(['read']);
    expect(v.disabled_reasons.create_project).toMatch(/owner or operator/);
    const c = authorityFor(ctx('client'), 'workspace');
    expect(c.allowed_actions).toEqual([]);
    expect(c.disabled_reasons.read).toMatch(/client role cannot read/);
  });
  it('service-principal tokens are read-only on workspaces', () => {
    const a = authorityFor(ctx('operator', { service_principal: 'customer_token' }), 'workspace');
    expect(a.allowed_actions).toEqual(['read']);
    expect(a.disabled_reasons.edit).toMatch(/read-only/);
  });
});

describe('A-W2c authorityFor · synthetic_domain resource', () => {
  it('owner/operator may create/edit/archive/refresh_membership', () => {
    expect(authorityFor(ctx('owner'), 'synthetic_domain').allowed_actions)
      .toEqual(['read', 'create', 'edit', 'archive', 'refresh_membership']);
  });
  it('viewer reads only (route blocks client outright)', () => {
    const v = authorityFor(ctx('viewer'), 'synthetic_domain');
    expect(v.allowed_actions).toEqual(['read']);
    expect(Object.keys(v.disabled_reasons).sort())
      .toEqual(['archive', 'create', 'edit', 'refresh_membership']);
  });
  it('client may take no synthetic_domain action', () => {
    expect(authorityFor(ctx('client'), 'synthetic_domain').allowed_actions).toEqual([]);
  });
});

describe('A-W2c authorityFor · member read denied for client (F10 matrix alignment)', () => {
  it('viewer may read the roster; client may not', () => {
    expect(authorityFor(ctx('viewer'), 'member').allowed_actions).toContain('read');
    const c = authorityFor(ctx('client'), 'member');
    expect(c.allowed_actions).not.toContain('read');
    expect(c.disabled_reasons.read).toMatch(/client role cannot read/);
  });
});

describe('M4 withAuthority envelope', () => {
  it('adds allowed_actions + disabled_reasons without mutating existing keys', () => {
    const out = withAuthority({ projects: [{ id: 'p1' }] }, ctx('viewer'), 'project');
    expect(out.projects).toEqual([{ id: 'p1' }]);
    expect(out.allowed_actions).toEqual(['read']);
    expect(typeof out.disabled_reasons).toBe('object');
  });
});
