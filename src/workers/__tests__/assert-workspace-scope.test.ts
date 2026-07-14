// assert-workspace-scope.test.ts · J-W5/TC-3 (260711-I) — pins the tenant-isolation PRIMITIVE.
//
// assertWorkspaceScope (dal/DalAdapter.ts) is the shared guard ~20 DAL stores call before every
// tenant-scoped query: no workspace_id → throw UNAUTHORIZED/401, never a query. It had ZERO direct
// tests, so a regression that weakened it (e.g. accepting '' or whitespace, or not throwing) would
// pass ci-local silently and open a cross-tenant read/write. This locks the four reject cases + the
// accept case so the primitive can't rot.

import { describe, it, expect } from 'vitest';
import { assertWorkspaceScope } from '../dal/DalAdapter';

function thrown(input: unknown): { code?: string; status?: number } | null {
  try {
    assertWorkspaceScope(input as never);
    return null;
  } catch (e) {
    return e as { code?: string; status?: number };
  }
}

describe('assertWorkspaceScope · tenant-isolation primitive (TC-3)', () => {
  it('REJECTS undefined with UNAUTHORIZED/401', () => {
    const e = thrown(undefined);
    expect(e).not.toBeNull();
    expect(e!.code).toBe('UNAUTHORIZED');
    expect(e!.status).toBe(401);
  });

  it('REJECTS null', () => {
    expect(thrown(null)?.status).toBe(401);
  });

  it('REJECTS an empty string', () => {
    expect(thrown('')?.status).toBe(401);
  });

  it('REJECTS a whitespace-only string (would otherwise pass a naive truthy check)', () => {
    expect(thrown('   ')?.status).toBe(401);
  });

  it('REJECTS a non-string (number coerced in), guarding against typeof bypass', () => {
    expect(thrown(123)?.status).toBe(401);
  });

  it('ACCEPTS a real workspace id (does not throw)', () => {
    expect(thrown('ws_abc123')).toBeNull();
  });
});
