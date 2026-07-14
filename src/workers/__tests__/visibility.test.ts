// visibility.test.ts · vitest pure-function tests for role → visibility mapping
//
// Run via: npm run test:workers

import { describe, it, expect } from 'vitest';
import { visibilityForRole, clerkRoleToWorkspaceRole } from '../dal/visibility';

describe('visibilityForRole', () => {
  it('owner sees all 4 visibility levels including internal_owner_only', () => {
    expect(visibilityForRole('owner')).toEqual([
      'internal_workspace',
      'internal_project',
      'internal_owner_only',
      'public_safe',
    ]);
  });

  it('operator sees workspace + project + public (no owner_only)', () => {
    expect(visibilityForRole('operator')).toEqual([
      'internal_workspace',
      'internal_project',
      'public_safe',
    ]);
  });

  it('viewer sees project + public only', () => {
    expect(visibilityForRole('viewer')).toEqual(['internal_project', 'public_safe']);
  });

  it('client sees public_safe only', () => {
    expect(visibilityForRole('client')).toEqual(['public_safe']);
  });

  it('returns array of valid visibility strings for every role', () => {
    const roles: Array<'owner' | 'operator' | 'viewer' | 'client'> = [
      'owner', 'operator', 'viewer', 'client',
    ];
    const valid = new Set(['internal_workspace', 'internal_project', 'internal_owner_only', 'public_safe']);
    for (const r of roles) {
      const visList = visibilityForRole(r);
      expect(visList.length).toBeGreaterThan(0);
      visList.forEach(v => expect(valid.has(v)).toBe(true));
    }
  });
});

describe('clerkRoleToWorkspaceRole (Day 1 mapping)', () => {
  it('org:admin → operator', () => {
    expect(clerkRoleToWorkspaceRole('org:admin')).toBe('operator');
  });

  it('org:member → viewer', () => {
    expect(clerkRoleToWorkspaceRole('org:member')).toBe('viewer');
  });

  it('null → viewer (safest default)', () => {
    expect(clerkRoleToWorkspaceRole(null)).toBe('viewer');
  });

  it('undefined → viewer (safest default)', () => {
    expect(clerkRoleToWorkspaceRole(undefined)).toBe('viewer');
  });

  it('unknown role → viewer (safest default)', () => {
    expect(clerkRoleToWorkspaceRole('org:unknown_future_role')).toBe('viewer');
  });

  it('empty string → viewer', () => {
    expect(clerkRoleToWorkspaceRole('')).toBe('viewer');
  });
});
