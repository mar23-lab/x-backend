// invite-membership-store.test.ts · AI-EXEC-2 · the access-boundary guards, pinned.
// The materialization is a GOVERNED WRITE on tenant access — every guard gets a RED/GREEN control.

import { describe, it, expect, vi } from 'vitest';
import { materializeInvitedMembershipRow } from '../dal/invite-membership-store';
import type { WorkspaceRole } from '../dal/types/identity';

// Mock the neon sql tag: each tagged-template call shifts the next queued result; .transaction is a spy.
function mockSql(seq: unknown[][]) {
  const q = [...seq];
  const fn = ((..._args: unknown[]) => Promise.resolve(q.length ? q.shift() : [])) as unknown as {
    (...a: unknown[]): Promise<unknown>;
    transaction: ReturnType<typeof vi.fn>;
    calls: number;
  };
  fn.transaction = vi.fn(async () => {});
  return fn;
}

const WS = 'org_x';
const USER = 'user_1';

describe('materializeInvitedMembershipRow · access-boundary guards', () => {
  it('REFUSES owner (ownership is a create-time act, never an invite grant)', async () => {
    const sql = mockSql([]);
    const r = await materializeInvitedMembershipRow(sql as never, { workspaceId: WS, userId: USER, role: 'owner' as WorkspaceRole });
    expect(r).toEqual({ materialized: false, role: null, reason: 'role_not_joinable' });
    expect(sql.transaction).not.toHaveBeenCalled();
  });

  it('REFUSES client (the redaction boundary is never auto-granted)', async () => {
    const sql = mockSql([]);
    const r = await materializeInvitedMembershipRow(sql as never, { workspaceId: WS, userId: USER, role: 'client' as WorkspaceRole });
    expect(r.reason).toBe('role_not_joinable');
    expect(sql.transaction).not.toHaveBeenCalled();
  });

  it('does NOT materialize when the workspace does not exist (join-only, never create)', async () => {
    const sql = mockSql([[]]); // guard 1: no workspace
    const r = await materializeInvitedMembershipRow(sql as never, { workspaceId: WS, userId: USER, role: 'viewer' });
    expect(r.reason).toBe('workspace_not_found');
    expect(sql.transaction).not.toHaveBeenCalled();
  });

  it('does NOT touch an existing member row (no resurrect, no demote)', async () => {
    const sql = mockSql([[{ id: WS }], [{ x: 1 }]]); // ws exists, member row exists
    const r = await materializeInvitedMembershipRow(sql as never, { workspaceId: WS, userId: USER, role: 'operator' });
    expect(r.reason).toBe('member_exists');
    expect(sql.transaction).not.toHaveBeenCalled();
  });

  it('NEVER un-bans a suspended/rejected user', async () => {
    const sql = mockSql([[{ id: WS }], [], [{ status: 'suspended' }]]); // ws, no member, banned user
    const r = await materializeInvitedMembershipRow(sql as never, { workspaceId: WS, userId: USER, role: 'viewer' });
    expect(r.reason).toBe('user_banned');
    expect(sql.transaction).not.toHaveBeenCalled();
  });

  it('materializes a NEW viewer (invited org:member, no prior user row)', async () => {
    const sql = mockSql([[{ id: WS }], [], []]); // ws, no member, no user row
    const r = await materializeInvitedMembershipRow(sql as never, { workspaceId: WS, userId: USER, role: 'viewer' });
    expect(r).toEqual({ materialized: true, role: 'viewer', reason: 'ok' });
    expect(sql.transaction).toHaveBeenCalledTimes(1);
  });

  it('materializes an operator (invited org:admin, pending user → approved)', async () => {
    const sql = mockSql([[{ id: WS }], [], [{ status: 'pending' }]]);
    const r = await materializeInvitedMembershipRow(sql as never, { workspaceId: WS, userId: USER, role: 'operator' });
    expect(r.materialized).toBe(true);
    expect(r.role).toBe('operator');
    expect(sql.transaction).toHaveBeenCalledTimes(1);
  });
});
