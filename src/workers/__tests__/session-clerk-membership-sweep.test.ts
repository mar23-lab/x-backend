// session-clerk-membership-sweep.test.ts · A5 Option B · the SERVER-SIDE membership backstop, pinned.
//
// WHY THIS FILE EXISTS (measured 260731 on production, both sides at the same moment):
//
//   Clerk    Honest & Young (org_3EI0xhBsYKWHbLmtjdvNVY6Yqhz) — 3 members;
//            the operator account ACCEPTED since 2026-07-29
//   Xlooop   workspace_members for that org — 1 row
//            workspace_members where activated_by='invite-materialization' — 0, table-wide
//
// The route precondition was already widened (see session-invite-entitlement-matrix.test.ts, which
// fixed the per-user-vs-per-pair cardinality bug). That fix was necessary and is NOT sufficient,
// because the whole claim-driven path can only ever answer for the ONE organization Clerk made
// ACTIVE in the token: `org_id`/`org_role` are emitted for the active org and nothing else. A user
// who belongs to several organizations therefore has exactly one of them represented per session,
// and every other accepted membership stays invisible to the route forever.
//
// The client-side auto-activate (pick the most-recently-joined org) shipped, the operator signed out
// and back in TWICE, and the row count stayed at zero — because for someone who already owns eight
// organizations, "most recently joined" is not reliably the one they were invited to. The client
// cannot answer this question. Only Clerk can, and only if the server asks.
//
// So this suite drives the ROUTE across the populations that reach the backstop:
//
//   1  multi-org user, token carries NO usable org claim  -> sweeps, materializes EVERY accepted org
//   2  zero-org user (Clerk returns [])                   -> no writes, no state change
//   3  already materialized (store says member_exists)    -> attempted, refused, no response field
//   4  Clerk unreachable (the API throws)                 -> fail-OPEN to today's behaviour, 200
//   5  token DID answer (org_id + org_role present)       -> claim path only, NO redundant sweep
//   6  flag OFF / secret unbound                          -> no sweep at all
//   7  access_denied                                      -> no sweep (a platform ban outranks Clerk)
//   8  one org failing                                    -> the REST still materialize
//
// Proven red before green: with the sweep block removed from session.ts, cases 1, 1b, 8 and 9 fail
// (0 materialize calls against an expected 2), which is precisely the production symptom.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Both Clerk entry points are per-case, so a hoisted holder lets each test set them before the
// request. `listResult` doubles as the throw switch: a function that throws models Clerk being down.
const clerk = vi.hoisted(() => ({
  claims: {} as Record<string, unknown>,
  listResult: (() => [] as unknown) as () => unknown,
  listCalls: 0,
}));

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async () => clerk.claims),
  createClerkClient: vi.fn(() => ({
    users: {
      getOrganizationMembershipList: vi.fn(async () => {
        clerk.listCalls += 1;
        return clerk.listResult();
      }),
    },
  })),
}));

import { sessionRoute } from '../routes/session';

const USER = 'user_multi_org';
const EMAIL = 'partner@example.com';
const ORG_A = 'org_honest_and_young';
const ORG_B = 'org_second_partner';
const OWN_WS = 'ws_owned_by_me';

/** The production population: this user already owns a workspace, so the entitlement gate is happy. */
const OWNS_OTHER_WORKSPACE = {
  state: 'approved_workspace',
  user: { id: USER, email: EMAIL, role: 'owner' },
  workspace: { id: OWN_WS, name: 'My Own Workspace', slug: 'my-own-workspace' },
  projects: [],
  message: 'Active workspace.',
};

const NO_WORKSPACE = {
  state: 'authenticated_no_access',
  user: { id: USER, email: EMAIL, role: 'viewer' },
  workspace: null,
  projects: [],
  message: 'You are not an active member of the selected company workspace. Contact admin.',
};

const DENIED = {
  state: 'access_denied',
  user: { id: USER, email: EMAIL, role: 'viewer' },
  workspace: null,
  projects: [],
  message: 'Access denied.',
};

interface SweepCase {
  claims: Record<string, unknown>;
  entitlements: object[];
  /** What Clerk reports, or a thrower to model Clerk being down. */
  clerkMemberships: () => unknown;
  /** Per-workspace store outcome; anything unlisted materializes. */
  storeOutcome?: Record<string, { materialized: boolean; role?: string | null; reason?: string }>;
  /** Workspaces whose materialization THROWS (models one bad row among several). */
  storeThrows?: string[];
  env?: Record<string, string>;
}

async function callSession(c: SweepCase) {
  clerk.claims = c.claims;
  clerk.listResult = c.clerkMemberships;
  clerk.listCalls = 0;

  const materializeCalls: Array<Record<string, unknown>> = [];
  let reads = 0;

  const dal = {
    getSessionEntitlement: async () => {
      const e = c.entitlements[Math.min(reads, c.entitlements.length - 1)]!;
      reads += 1;
      return JSON.parse(JSON.stringify(e)); // the route mutates the object it is handed
    },
    listAccessRequests: async () => [],
    getOperatingMode: async () => 'watch',
    materializeInvitedMembership: async (input: Record<string, unknown>) => {
      materializeCalls.push(input);
      const ws = String(input.workspaceId);
      if (c.storeThrows?.includes(ws)) throw new Error(`store blew up on ${ws}`);
      const out = c.storeOutcome?.[ws];
      if (out) return { materialized: out.materialized, role: out.role ?? null, reason: out.reason ?? null };
      return { materialized: true, role: input.role, reason: null };
    },
  };

  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', sessionRoute);

  const res = await app.request(
    '/api/v1/session',
    { headers: { Authorization: 'Bearer faketoken' } },
    {
      CLERK_SECRET_KEY: 'sk_test', // verifyToken + createClerkClient are mocked; the value is unused
      INVITE_MEMBERSHIP_MATERIALIZATION_ENABLED: 'true', // as deployed (wrangler.toml:267)
      ...(c.env ?? {}),
    } as never,
  );

  return {
    status: res.status,
    body: (await res.json()) as {
      state?: string;
      clerk_membership_sweep_materialized?: string[];
    },
    materializeCalls,
    listCalls: clerk.listCalls,
  };
}

/** Clerk's paginated envelope; the SDK has also returned a bare array, and both are accepted. */
const membership = (organizationId: string, role: string) => ({ organization: { id: organizationId }, role });

/** No active org => Clerk signs no org_id/org_role. This is the token the operator actually had. */
const NO_ORG_CLAIMS = { sub: USER, email: EMAIL };

describe('session route · Clerk membership SWEEP (A5 Option B backstop)', () => {
  it('1 · multi-org user with no active org -> materializes EVERY accepted membership', async () => {
    // The production case. The token can name at most one org; Clerk knows about both.
    const r = await callSession({
      claims: NO_ORG_CLAIMS,
      entitlements: [OWNS_OTHER_WORKSPACE],
      clerkMemberships: () => ({ data: [membership(ORG_A, 'org:admin'), membership(ORG_B, 'org:member')] }),
    });

    expect(r.status).toBe(200);
    expect(r.listCalls).toBe(1);
    expect(r.materializeCalls).toHaveLength(2);
    // org:admin -> operator, org:member -> viewer (clerkRoleToWorkspaceRole). The sweep must not
    // flatten every invitee to viewer, or an invited admin silently loses authority Clerk granted.
    expect(r.materializeCalls[0]).toMatchObject({ workspaceId: ORG_A, userId: USER, role: 'operator', email: EMAIL });
    expect(r.materializeCalls[1]).toMatchObject({ workspaceId: ORG_B, userId: USER, role: 'viewer', email: EMAIL });
    expect(r.body.clerk_membership_sweep_materialized).toEqual([ORG_A, ORG_B]);
  });

  it('1b · accepts a BARE ARRAY from Clerk as well as the { data } envelope', async () => {
    // The SDK has returned both shapes across versions. Pinning one and reading zero after an upgrade
    // would reproduce exactly the silent-zero defect this backstop exists to fix.
    const r = await callSession({
      claims: NO_ORG_CLAIMS,
      entitlements: [OWNS_OTHER_WORKSPACE],
      clerkMemberships: () => [membership(ORG_A, 'org:member')],
    });
    expect(r.materializeCalls).toHaveLength(1);
    expect(r.materializeCalls[0]).toMatchObject({ workspaceId: ORG_A, role: 'viewer' });
  });

  it('2 · zero-org user -> Clerk asked, nothing written, session unchanged', async () => {
    const r = await callSession({
      claims: NO_ORG_CLAIMS,
      entitlements: [NO_WORKSPACE],
      clerkMemberships: () => ({ data: [] }),
    });
    expect(r.status).toBe(200);
    expect(r.listCalls).toBe(1);
    expect(r.materializeCalls).toHaveLength(0);
    expect(r.body.clerk_membership_sweep_materialized).toBeUndefined();
    expect(r.body.state).toBe('authenticated_no_access');
  });

  it('3 · already materialized -> attempted, refused by the store, no state mutation', async () => {
    // The steady state. This runs on EVERY claim-less session, so "already done" must be a cheap,
    // silent no-op rather than a repeated write or a spurious response field.
    const r = await callSession({
      claims: NO_ORG_CLAIMS,
      entitlements: [OWNS_OTHER_WORKSPACE],
      clerkMemberships: () => ({ data: [membership(ORG_A, 'org:member')] }),
      storeOutcome: { [ORG_A]: { materialized: false, reason: 'member_exists' } },
    });
    expect(r.status).toBe(200);
    expect(r.materializeCalls).toHaveLength(1);
    expect(r.body.clerk_membership_sweep_materialized).toBeUndefined();
    expect(r.body.state).toBe('approved_workspace');
  });

  it('4 · Clerk unreachable -> FAIL-OPEN to current behaviour, never a failed sign-in', async () => {
    // The deliberate inversion of this repo's fail-closed default, and it is safe for one reason:
    // the sweep can only ADD a membership Clerk has ALREADY granted, so an empty result is strictly
    // less privilege. A degraded Clerk must not be able to lock out users who are already entitled.
    const r = await callSession({
      claims: NO_ORG_CLAIMS,
      entitlements: [OWNS_OTHER_WORKSPACE],
      clerkMemberships: () => { throw new Error('ECONNRESET'); },
    });
    expect(r.status).toBe(200);
    expect(r.materializeCalls).toHaveLength(0);
    expect(r.body.state).toBe('approved_workspace'); // exactly what today's code returns
  });

  it('5 · the token DID answer -> claim path only, NO redundant Clerk call', async () => {
    // Cost control, and it is the difference between one extra call on a rare path and one extra
    // call on every authenticated session in the product.
    const r = await callSession({
      claims: { sub: USER, email: EMAIL, org_id: ORG_A, org_role: 'org:member' },
      entitlements: [OWNS_OTHER_WORKSPACE],
      clerkMemberships: () => ({ data: [membership(ORG_B, 'org:member')] }),
    });
    expect(r.status).toBe(200);
    expect(r.listCalls).toBe(0);
    // ORG_A only, via the existing claim-driven path — ORG_B is NOT swept on this session.
    expect(r.materializeCalls).toHaveLength(1);
    expect(r.materializeCalls[0]).toMatchObject({ workspaceId: ORG_A });
  });

  it('6 · flag OFF -> no sweep', async () => {
    const r = await callSession({
      claims: NO_ORG_CLAIMS,
      entitlements: [OWNS_OTHER_WORKSPACE],
      clerkMemberships: () => ({ data: [membership(ORG_A, 'org:member')] }),
      env: { INVITE_MEMBERSHIP_MATERIALIZATION_ENABLED: 'false' },
    });
    expect(r.listCalls).toBe(0);
    expect(r.materializeCalls).toHaveLength(0);
  });

  it('6b · CLERK_SECRET_KEY unbound -> no sweep, session still 200', async () => {
    const r = await callSession({
      claims: NO_ORG_CLAIMS,
      entitlements: [OWNS_OTHER_WORKSPACE],
      clerkMemberships: () => ({ data: [membership(ORG_A, 'org:member')] }),
      env: { CLERK_SECRET_KEY: '' },
    });
    expect(r.status).toBe(200);
    expect(r.listCalls).toBe(0);
    expect(r.materializeCalls).toHaveLength(0);
  });

  it('7 · access_denied -> no sweep (a platform ban outranks any Clerk invitation)', async () => {
    const r = await callSession({
      claims: NO_ORG_CLAIMS,
      entitlements: [DENIED],
      clerkMemberships: () => ({ data: [membership(ORG_A, 'org:admin')] }),
    });
    expect(r.listCalls).toBe(0);
    expect(r.materializeCalls).toHaveLength(0);
    expect(r.body.state).toBe('access_denied');
  });

  it('8 · one org failing must NOT abandon the rest', async () => {
    // A single bad row should never strand a user from every other workspace they belong to.
    const r = await callSession({
      claims: NO_ORG_CLAIMS,
      entitlements: [OWNS_OTHER_WORKSPACE],
      clerkMemberships: () => ({ data: [membership(ORG_A, 'org:member'), membership(ORG_B, 'org:admin')] }),
      storeThrows: [ORG_A],
    });
    expect(r.status).toBe(200);
    expect(r.materializeCalls).toHaveLength(2);
    expect(r.body.clerk_membership_sweep_materialized).toEqual([ORG_B]);
  });

  it('9 · malformed Clerk rows are skipped, not guessed at', async () => {
    // A row missing its organization id cannot be bound to a workspace. Inventing one would be the
    // fabrication class this programme exists to remove.
    const r = await callSession({
      claims: NO_ORG_CLAIMS,
      entitlements: [OWNS_OTHER_WORKSPACE],
      clerkMemberships: () => ({
        data: [{ organization: {}, role: 'org:member' }, { role: 'org:member' }, membership(ORG_B, 'org:member')],
      }),
    });
    expect(r.materializeCalls).toHaveLength(1);
    expect(r.materializeCalls[0]).toMatchObject({ workspaceId: ORG_B });
  });
});
