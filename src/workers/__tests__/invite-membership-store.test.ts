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

  // ── AMBIGUITY, ALIGNED WITH A6 (260731) ──────────────────────────────────────────────────────
  //
  // The guard used to count EVERY row sharing the email, including ones A6 had already suspended —
  // so it stayed permanently tripped for exactly the identity A6 was built to disambiguate. Measured
  // on production: marat@xlooop.com had one SUSPENDED row (0 memberships, retained because it holds
  // 8 audit_logs rows as actor) and one ACTIVE row (8 memberships). No ambiguity existed, and the
  // guard refused every materialization for that human anyway.
  //
  // The query now filters `suspended_at IS NULL`, matching the premise of A6's PARTIAL unique index
  // `users_email_ci_unique_active`. Both directions are pinned below, because relaxing a fail-closed
  // guard is only safe if the case it exists for still fails.

  it('AMBIGUITY still refuses when TWO ACTIVE rows share the email (the guard is not weakened)', async () => {
    // ws exists, no member row, user not banned, TWO active rows for the email
    const sql = mockSql([[{ id: WS }], [], [{ status: 'approved' }], [{ id: 'user_a' }, { id: 'user_b' }]]);
    const r = await materializeInvitedMembershipRow(sql as never, {
      workspaceId: WS, userId: USER, role: 'viewer', email: 'dup@example.com',
    });
    expect(r.reason).toBe('identity_ambiguous');
    expect(sql.transaction).not.toHaveBeenCalled();
  });

  it('a SUSPENDED duplicate no longer blocks — the production marat@xlooop.com shape', async () => {
    // The query now excludes suspended rows, so the driver returns ONE row and materialization runs.
    const sql = mockSql([[{ id: WS }], [], [{ status: 'approved' }], [{ id: 'user_3EIN_active' }]]);
    const r = await materializeInvitedMembershipRow(sql as never, {
      workspaceId: WS, userId: USER, role: 'viewer', email: 'marat@xlooop.com',
    });
    expect(r.materialized).toBe(true);
    expect(r.reason).toBe('ok');
    expect(sql.transaction).toHaveBeenCalledTimes(1);
  });

  it('the ambiguity query FILTERS suspended rows — asserted on the SQL, not just the outcome', async () => {
    // The two tests above pass on driver-shaped fixtures and would keep passing if the filter were
    // removed, because the mock returns whatever it is queued with. This one reads the emitted SQL,
    // which is the only thing that can distinguish "the filter is there" from "the fixture was kind".
    const seen: string[] = [];
    // Same queued-result contract as mockSql, but it also RECORDS the SQL text of each call so the
    // assertion can read the query rather than infer it from the outcome.
    const queued: unknown[][] = [[{ id: WS }], [], [{ status: 'approved' }], [{ id: 'only_one' }]];
    const sql = Object.assign(
      (strings: TemplateStringsArray) => {
        seen.push(Array.from(strings).join('?'));
        return Promise.resolve(queued.length ? queued.shift() : []);
      },
      { transaction: vi.fn(async () => {}) },
    );
    await materializeInvitedMembershipRow(sql as never, {
      workspaceId: WS, userId: USER, role: 'viewer', email: 'x@example.com',
    }).catch(() => {});
    const ambiguityQuery = seen.find((q) => /FROM users WHERE lower\(email\)/i.test(q));
    expect(ambiguityQuery).toBeDefined();
    expect(ambiguityQuery).toMatch(/suspended_at IS NULL/i);
  });
});
