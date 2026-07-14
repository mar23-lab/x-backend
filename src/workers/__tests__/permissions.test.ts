// permissions.test.ts — locks the central RBAC SSOT contract (P4 · 260629).
// Guards the consolidated canWrite / isOperatorRole / operatorIds that the spine/mcp/synthetic-domains/
// workspaces/graph routes now import, so a future edit can't silently widen who may write or who counts as
// the MB-P operator.

import { describe, it, expect } from 'vitest';
import { canWrite, isOperatorRole, operatorIds } from '../lib/permissions';

describe('permissions.canWrite — operational-spine write gate', () => {
  it('owner + operator MAY write', () => {
    expect(canWrite('owner')).toBe(true);
    expect(canWrite('operator')).toBe(true);
  });

  it('viewer / client / unknown / empty / undefined are read-only', () => {
    expect(canWrite('viewer')).toBe(false);
    expect(canWrite('client')).toBe(false);
    // a future `developer` role does NOT get spine-write via this gate unless explicitly added here:
    expect(canWrite('developer')).toBe(false);
    expect(canWrite('')).toBe(false);
    expect(canWrite(undefined)).toBe(false);
  });
});

describe('permissions.isOperatorRole — operator-only read surfaces', () => {
  it('owner + operator are operator-role', () => {
    expect(isOperatorRole('owner')).toBe(true);
    expect(isOperatorRole('operator')).toBe(true);
  });
  it('viewer / client / undefined are not', () => {
    expect(isOperatorRole('viewer')).toBe(false);
    expect(isOperatorRole('client')).toBe(false);
    expect(isOperatorRole(undefined)).toBe(false);
  });
});

describe('permissions.operatorIds — MB-P operator identity set', () => {
  it('owner + comma-separated linked ids, trimmed', () => {
    const r = operatorIds({ MBP_OWNER_USER_ID: ' u_owner ', MBP_OWNER_LINKED_USER_IDS: 'u_a, u_b ,' });
    expect(r.ownerUserId).toBe('u_owner');
    expect(r.ids).toEqual(['u_owner', 'u_a', 'u_b']);
  });
  it('empty / null / undefined env → empty set', () => {
    expect(operatorIds({})).toEqual({ ownerUserId: '', ids: [] });
    expect(operatorIds(null)).toEqual({ ownerUserId: '', ids: [] });
    expect(operatorIds(undefined)).toEqual({ ownerUserId: '', ids: [] });
  });
});
