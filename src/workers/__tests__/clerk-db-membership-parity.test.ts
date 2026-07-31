// clerk-db-membership-parity.test.ts · the comparator for the silent-strand class, pinned.
//
// The headline case below is not invented. It is the production incident, transcribed: Clerk showed
// Honest & Young with 3 members while workspace_members held 1, for two days, with every gate green.
// A comparator that cannot reproduce the incident it was built for is decoration, so that state is
// the first test.

import { describe, it, expect } from 'vitest';
import { diffMemberships, summarizeParity } from '../lib/clerk-db-membership-parity';

const WS = 'org_3EI0xhBsYKWHbLmtjdvNVY6Yqhz'; // Honest & Young, the real org id from the incident

describe('diffMemberships · the silent-strand comparator', () => {
  it('reproduces THE 260731 INCIDENT: Clerk 3, DB 1 -> two stranded members named', () => {
    const r = diffMemberships({
      workspaceId: WS,
      clerk: [
        { userId: 'user_owner', role: 'owner' },
        { userId: 'user_xlooop23', role: 'viewer' },
        { userId: 'user_marat', role: 'viewer' },
      ],
      db: [{ userId: 'user_owner', role: 'owner' }],
    });
    expect(r.clerkCount).toBe(3);
    expect(r.dbCount).toBe(1);
    expect(r.clerkOnly).toEqual(['user_marat', 'user_xlooop23']); // sorted, so the report is stable
    expect(r.dbOnly).toEqual([]);
    expect(r.diverged).toBe(true);
  });

  it('parity is silent — no divergence, nothing to report', () => {
    const r = diffMemberships({
      workspaceId: WS,
      clerk: [{ userId: 'a', role: 'owner' }, { userId: 'b', role: 'viewer' }],
      db: [{ userId: 'b', role: 'viewer' }, { userId: 'a', role: 'owner' }], // order must not matter
    });
    expect(r.diverged).toBe(false);
    expect(r.clerkOnly).toEqual([]);
    expect(r.dbOnly).toEqual([]);
    expect(r.roleMismatch).toEqual([]);
  });

  it('THE OTHER DIRECTION is a security finding, not a symmetric one', () => {
    // A DB row Clerk does not know about means revoking in Clerk does NOT revoke in Xlooop. The
    // comparator must surface this as loudly as the stranded-customer case, or a removal that
    // silently failed looks identical to parity.
    const r = diffMemberships({
      workspaceId: WS,
      clerk: [{ userId: 'a', role: 'owner' }],
      db: [{ userId: 'a', role: 'owner' }, { userId: 'ghost', role: 'operator' }],
    });
    expect(r.dbOnly).toEqual(['ghost']);
    expect(r.clerkOnly).toEqual([]);
    expect(r.diverged).toBe(true);
  });

  it('a role mismatch is REPORTED but does NOT count as divergence', () => {
    // Deliberate. clerkRoleToWorkspaceRole is lossy, and an operator may promote through
    // PATCH /members/:id/role with no Clerk change. Escalating that would make the loop fire on
    // ordinary administration — and an alarm that fires on normal operations gets muted.
    const r = diffMemberships({
      workspaceId: WS,
      clerk: [{ userId: 'a', role: 'viewer' }],
      db: [{ userId: 'a', role: 'operator' }],
    });
    expect(r.roleMismatch).toEqual([{ userId: 'a', clerk: 'viewer', db: 'operator' }]);
    expect(r.diverged).toBe(false);
  });

  it('BOTH SIDES EMPTY is parity, not a failure — and both-sides-empty must not read as an error', () => {
    const r = diffMemberships({ workspaceId: WS, clerk: [], db: [] });
    expect(r.diverged).toBe(false);
    expect(r.clerkCount).toBe(0);
    expect(r.dbCount).toBe(0);
  });

  it('an EMPTY DB against a populated Clerk is the worst case and is caught', () => {
    // The shape a total materialization failure takes. If the comparator treated an empty side as
    // "nothing to compare" it would go quiet exactly when it matters most — the false-zero class.
    const r = diffMemberships({
      workspaceId: WS,
      clerk: [{ userId: 'a', role: 'owner' }, { userId: 'b', role: 'viewer' }],
      db: [],
    });
    expect(r.clerkOnly).toEqual(['a', 'b']);
    expect(r.diverged).toBe(true);
  });

  it('malformed rows are skipped, never guessed at', () => {
    const r = diffMemberships({
      workspaceId: WS,
      clerk: [{ userId: '', role: 'owner' }, { userId: 'a', role: 'viewer' }],
      db: [{ userId: 'a', role: 'viewer' }],
    });
    expect(r.clerkCount).toBe(1); // the empty id contributed nothing
    expect(r.diverged).toBe(false);
  });

  it('duplicate ids on one side collapse instead of inflating the count', () => {
    const r = diffMemberships({
      workspaceId: WS,
      clerk: [{ userId: 'a', role: 'viewer' }, { userId: 'a', role: 'viewer' }],
      db: [{ userId: 'a', role: 'viewer' }],
    });
    expect(r.clerkCount).toBe(1);
    expect(r.diverged).toBe(false);
  });
});

describe('summarizeParity · the loop verdict', () => {
  it('counts only diverged workspaces and names them', () => {
    const clean = diffMemberships({ workspaceId: 'ws_ok', clerk: [{ userId: 'a', role: 'x' }], db: [{ userId: 'a', role: 'x' }] });
    const bad = diffMemberships({ workspaceId: 'ws_bad', clerk: [{ userId: 'a', role: 'x' }], db: [] });
    const s = summarizeParity([clean, bad]);
    expect(s.workspaces).toBe(2);
    expect(s.diverged).toBe(1);
    expect(s.divergedWorkspaceIds).toEqual(['ws_bad']);
    expect(s.clerkOnlyTotal).toBe(1);
    expect(s.dbOnlyTotal).toBe(0);
  });

  it('an empty run summarizes to zero WITHOUT claiming health', () => {
    // `workspaces: 0` is the honest reading. The cron arm is what must refuse to render this as a
    // clean bill of health — the summary's job is to report the denominator, not to interpret it.
    const s = summarizeParity([]);
    expect(s.workspaces).toBe(0);
    expect(s.diverged).toBe(0);
    expect(s.divergedWorkspaceIds).toEqual([]);
  });

  it('role mismatches are totalled separately from divergence', () => {
    const m = diffMemberships({ workspaceId: 'ws', clerk: [{ userId: 'a', role: 'viewer' }], db: [{ userId: 'a', role: 'operator' }] });
    const s = summarizeParity([m]);
    expect(s.roleMismatchTotal).toBe(1);
    expect(s.diverged).toBe(0);
  });
});
