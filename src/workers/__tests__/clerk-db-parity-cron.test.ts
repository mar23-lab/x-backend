// clerk-db-parity-cron.test.ts · P10 · the arm's SAFETY posture, pinned.
//
// The comparator's arithmetic is tested separately (clerk-db-membership-parity.test.ts). What this
// file pins is the part that decides whether the loop can LIE: born-off inertness, the refusal to
// report parity it could not measure, and observe-only.
//
// The controlling risk is not a wrong diff. It is a loop that reports "0 diverged" because Clerk was
// unreachable — that converts an outage into a clean bill of health, and it is the exact 260731
// shape (Clerk 3, DB 1) rendered as parity. So `listClerkMembers` returns null on failure and every
// test below that touches null asserts the loop refuses to call it clean.

import { describe, it, expect, vi } from 'vitest';
import { clerkDbParityCron } from '../crons/clerk-db-parity';

const NOW = new Date('2026-07-31T05:00:00.000Z');

function makeCtx(over: Record<string, unknown> = {}) {
  const clerkCalls: string[] = [];
  const base = {
    now: () => NOW,
    cronExpression: '0 5 * * *',
    dal: {} as never,
    env: { CLERK_DB_PARITY_ENABLED: 'true', CLERK_SECRET_KEY: 'sk_test' },
    parity: {
      listWorkspaceIds: async () => ['ws_a'],
      listClerkMembers: async (_s: string, ws: string) => {
        clerkCalls.push(ws);
        return [{ userId: 'u1', role: 'org:admin' }];
      },
      listDbMembers: async () => [{ userId: 'u1', role: 'operator' }],
    },
    ...over,
  };
  return { ctx: base as never, clerkCalls };
}

describe('clerkDbParityCron · safety posture', () => {
  it('BORN-OFF: without the flag it makes ZERO Clerk calls and zero reads', async () => {
    const listWorkspaceIds = vi.fn();
    const { ctx, clerkCalls } = makeCtx({
      env: { CLERK_SECRET_KEY: 'sk_test' }, // flag absent
      parity: { listWorkspaceIds, listClerkMembers: async () => [], listDbMembers: async () => [] },
    });
    const r = await clerkDbParityCron(ctx);
    expect(r.status).toBe('skipped');
    expect(r.metadata?.reason).toBe('flag_disabled');
    expect(listWorkspaceIds).not.toHaveBeenCalled();
    expect(clerkCalls).toEqual([]);
  });

  it('the flag must be exactly true — "TRUE " and "1" do not arm it', async () => {
    for (const v of ['1', 'yes', 'on', '']) {
      const { ctx } = makeCtx({ env: { CLERK_DB_PARITY_ENABLED: v, CLERK_SECRET_KEY: 'sk' } });
      expect((await clerkDbParityCron(ctx)).status).toBe('skipped');
    }
  });

  it('NO CLERK SECRET -> skipped, and explicitly NOT a pass', async () => {
    // The dangerous alternative is reporting success because nothing diverged in a comparison that
    // never happened.
    const { ctx } = makeCtx({ env: { CLERK_DB_PARITY_ENABLED: 'true' } });
    const r = await clerkDbParityCron(ctx);
    expect(r.status).toBe('skipped');
    expect(r.metadata?.reason).toBe('clerk_secret_absent');
    expect(r.status).not.toBe('completed');
  });

  it('CLERK UNREACHABLE (null, not []) -> degraded and counted as unmeasurable, never clean', async () => {
    // THE control that matters. A null must never be read as "Clerk has no members".
    const { ctx } = makeCtx({
      parity: {
        listWorkspaceIds: async () => ['ws_a'],
        listClerkMembers: async () => null,
        listDbMembers: async () => [{ userId: 'u1', role: 'operator' }],
      },
    });
    const r = await clerkDbParityCron(ctx);
    expect(r.status).toBe('degraded');
    const un = r.metadata?.unmeasurable as Array<{ workspaceId: string; reason: string }>;
    expect(un).toHaveLength(1);
    expect(r.metadata?.workspaces).toBe(0); // nothing was actually measured
    expect(r.metadata?.diverged).toBe(0);   // and zero-diverged must NOT read as healthy here
    // THE DISCRIMINATING ASSERTION. Deleting the null guard ALSO produces degraded — `.map()` on
    // null throws straight into the per-workspace catch — so status alone cannot tell a DETECTED
    // outage from a CRASH on one. Observed: with the guard removed this test still passed on
    // status, which is exactly the "green for the wrong reason" class this suite exists to catch.
    // The reason string is what distinguishes them.
    expect(un[0].reason).toBe('clerk_unreachable');
    expect(un[0].reason).not.toMatch(/undefined|null is not|Cannot read/i);
  });

  it('true parity -> success, and the Clerk role is MAPPED before comparing', async () => {
    // org:admin maps to operator. Without the mapping every admin would look like a role mismatch,
    // and the loop would be noisy on a perfectly healthy estate.
    const { ctx } = makeCtx();
    const r = await clerkDbParityCron(ctx);
    expect(r.status).toBe('completed');
    expect(r.metadata?.diverged).toBe(0);
    expect(r.metadata?.roleMismatchTotal).toBe(0);
  });

  it('reproduces the 260731 incident shape -> degraded, with the stranded user NAMED', async () => {
    const { ctx } = makeCtx({
      parity: {
        listWorkspaceIds: async () => ['org_3EI0xhBsYKWHbLmtjdvNVY6Yqhz'],
        listClerkMembers: async () => [
          { userId: 'u_owner', role: 'org:admin' },
          { userId: 'u_marat', role: 'org:member' },
          { userId: 'u_xl23', role: 'org:member' },
        ],
        listDbMembers: async () => [{ userId: 'u_owner', role: 'operator' }],
      },
    });
    const r = await clerkDbParityCron(ctx);
    expect(r.status).toBe('degraded');
    expect(r.metadata?.diverged).toBe(1);
    const details = r.metadata?.details as Array<{ clerkOnly: string[] }>;
    expect(details[0].clerkOnly).toEqual(['u_marat', 'u_xl23']); // a count nobody can act on is not enough
  });

  it('OBSERVE-ONLY: actions_taken is 0 even when it finds divergence', async () => {
    const { ctx } = makeCtx({
      parity: {
        listWorkspaceIds: async () => ['ws_a'],
        listClerkMembers: async () => [{ userId: 'stranded', role: 'org:member' }],
        listDbMembers: async () => [],
      },
    });
    const r = await clerkDbParityCron(ctx);
    expect(r.actions_taken).toBe(0);
    expect(r.notes).toContain('OBSERVE-ONLY');
  });

  it('one bad workspace does NOT abandon the rest', async () => {
    const { ctx } = makeCtx({
      parity: {
        listWorkspaceIds: async () => ['ws_bad', 'ws_ok'],
        listClerkMembers: async (_s: string, ws: string) => {
          if (ws === 'ws_bad') throw new Error('boom');
          return [{ userId: 'u1', role: 'org:member' }];
        },
        listDbMembers: async () => [{ userId: 'u1', role: 'viewer' }],
      },
    });
    const r = await clerkDbParityCron(ctx);
    expect(r.metadata?.workspaces).toBe(1); // ws_ok still measured
    expect((r.metadata?.unmeasurable as unknown[])).toHaveLength(1);
    expect(r.status).toBe('degraded');
  });

  it('an ABSENT gateway skips rather than throwing', async () => {
    const { ctx } = makeCtx({ parity: undefined });
    const r = await clerkDbParityCron(ctx);
    expect(r.status).toBe('skipped');
    expect(r.metadata?.reason).toBe('gateway_absent');
  });

  it('enumeration failure is FAILED, not silently empty', async () => {
    const { ctx } = makeCtx({
      parity: {
        listWorkspaceIds: async () => { throw new Error('db down'); },
        listClerkMembers: async () => [],
        listDbMembers: async () => [],
      },
    });
    const r = await clerkDbParityCron(ctx);
    expect(r.status).toBe('failed');
    expect(r.metadata?.reason).toBe('enumeration_failed');
  });
});
