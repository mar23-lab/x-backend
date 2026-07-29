// session-invite-entitlement-matrix.test.ts · the ROUTE precondition for invite materialization, pinned.
//
// WHY THIS FILE EXISTS (measured 260729, production Neon):
//   select count(*) from workspace_members where activated_by='invite-materialization'  -> 0
//   select count(*) from workspace_members where invited_by is not null                 -> 0
// The seam was wired, the flag was ON (wrangler.toml INVITE_MEMBERSHIP_MATERIALIZATION_ENABLED="true")
// at the deployed SHA, and the store was fully unit-tested -- yet not one membership had ever
// materialized. The store was never the problem: the ROUTE PRECONDITION was.
//
// The defect: session.ts gated a per-(user, workspace) question
//     "does this user have a member row for THIS orgId?"
// on a per-user GLOBAL state
//     "does this user have access to anything at all?"   (entitlement.state)
// Those two questions agree only for a user who owns no workspace. Every design partner owns one.
// marat@xlooop.com owns 8 workspaces (all owner:active) -> entitlement.state resolves to
// 'approved_workspace' via the trusted-platform fallback in WorkersDalAdapter.getSessionEntitlement,
// which returns the user's FIRST active workspace, NOT the invited org -> the branch was UNREACHABLE.
//
// The store had 7 green tests the whole time. Store coverage cannot see a caller that never calls.
// So this suite drives the ROUTE end-to-end (mocked Clerk JWT + a stub DAL that delegates to the REAL
// store) across the populations that reach this code path -- an entitlement matrix, not a happy path:
//
//   1  no workspace              + accepted invite  -> materializes  (the only case the old gate served)
//   2  ALREADY OWNS a workspace  + accepted invite  -> materializes  (THE BUG -- red before the fix)
//   2b already a member of the invited org          -> no redundant attempt (widening must not spam writes)
//   3  invited, NOT yet accepted (no signed org claims) -> does NOT materialize
//   4  ambiguous identity (>1 users row for the email)  -> REFUSES with an explicit reason
//
// Cases 2 and 4 were observed FAILING against the pre-fix code before the fix was written.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Clerk claims are per-case; a hoisted holder lets each test set them before the request.
const clerk = vi.hoisted(() => ({ claims: {} as Record<string, unknown> }));
vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async () => clerk.claims),
}));

import { sessionRoute } from '../routes/session';
import { materializeInvitedMembershipRow } from '../dal/invite-membership-store';

const ORG = 'org_partner';       // the workspace the invitee was invited to (Clerk org_id)
const OWN_WS = 'ws_owned_by_me'; // a workspace this user ALREADY owns (case 2)
const USER = 'user_invitee';
const EMAIL = 'partner@example.com';

/** Same mock-sql contract as invite-membership-store.test.ts: each tagged call shifts the next result. */
function mockSql(seq: unknown[][]) {
  const q = [...seq];
  const fn = ((..._args: unknown[]) => Promise.resolve(q.length ? q.shift() : [])) as unknown as {
    (...a: unknown[]): Promise<unknown>;
    transaction: ReturnType<typeof vi.fn>;
  };
  fn.transaction = vi.fn(async () => {});
  return fn;
}

// ---- entitlement fixtures (the shapes WorkersDalAdapter.getSessionEntitlement actually returns) ----

/** Brand-new invitee: approved user, no membership anywhere. */
const NO_WORKSPACE = {
  state: 'authenticated_no_access',
  user: { id: USER, email: EMAIL, role: 'viewer' },
  workspace: null,
  projects: [],
  message: 'You are not an active member of the selected company workspace. Contact admin.',
};

/**
 * THE PRODUCTION POPULATION: the user already owns a workspace, so the entitlement gate resolves
 * 'approved_workspace' -- for their OWN workspace, NOT the invited org. Note workspace.id !== ORG:
 * the per-pair question ("member of ORG?") is still NO while the global state says "has access".
 */
const OWNS_OTHER_WORKSPACE = {
  state: 'approved_workspace',
  user: { id: USER, email: EMAIL, role: 'owner' },
  workspace: { id: OWN_WS, name: 'My Own Workspace', slug: 'my-own-workspace' },
  projects: [],
  message: 'Active workspace.',
};

/** What the gate returns on the re-read AFTER a membership row lands in ORG. */
const MEMBER_OF_ORG = {
  state: 'approved_workspace',
  user: { id: USER, email: EMAIL, role: 'viewer' },
  workspace: { id: ORG, name: 'Partner Co', slug: 'partner-co' },
  projects: [],
  message: 'Active workspace.',
};

interface Case {
  claims: Record<string, unknown>;
  /** Successive getSessionEntitlement returns; the last one repeats. */
  entitlements: object[];
  /** Rows queued for the REAL store, in query order. */
  sqlSeq: unknown[][];
  env?: Record<string, string>;
}

async function callSession(c: Case) {
  clerk.claims = c.claims;
  const sql = mockSql(c.sqlSeq);
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
    // Delegate to the REAL store -- the precondition AND the store guards are both under test.
    materializeInvitedMembership: async (input: Record<string, unknown>) => {
      materializeCalls.push(input);
      return materializeInvitedMembershipRow(sql as never, input as never);
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
      CLERK_SECRET_KEY: 'x', // verifyToken is mocked; value unused
      INVITE_MEMBERSHIP_MATERIALIZATION_ENABLED: 'true', // as deployed (wrangler.toml:264)
      ...(c.env ?? {}),
    } as never,
  );

  return {
    status: res.status,
    body: (await res.json()) as {
      state?: string;
      workspace?: { id?: string } | null;
      invite_materialized_role?: string;
      invite_materialization_skipped_reason?: string;
    },
    materializeCalls,
    transaction: sql.transaction,
  };
}

// Clerk signs org_id/org_role ONLY for an ACCEPTED org member -- that signature IS the proof of an
// accepted invitation, which is why this seam needs no webhook.
const ACCEPTED_MEMBER_CLAIMS = { sub: USER, org_id: ORG, org_role: 'org:member', email: EMAIL };

describe('session route · invite materialization ENTITLEMENT MATRIX', () => {
  it('1 · user with NO workspace, invited + accepted -> materializes', async () => {
    const r = await callSession({
      claims: ACCEPTED_MEMBER_CLAIMS,
      entitlements: [NO_WORKSPACE, MEMBER_OF_ORG],
      // ws exists, no member row, user not banned, email unique
      sqlSeq: [[{ id: ORG }], [], [{ status: 'approved' }], [{ id: USER }]],
    });
    expect(r.status).toBe(200);
    expect(r.materializeCalls).toHaveLength(1);
    expect(r.materializeCalls[0]).toMatchObject({ workspaceId: ORG, userId: USER, role: 'viewer' });
    expect(r.transaction).toHaveBeenCalledTimes(1);
    expect(r.body.invite_materialized_role).toBe('viewer');
    expect(r.body.state).toBe('approved_workspace');
  });

  it('2 · user who ALREADY OWNS a workspace, invited + accepted -> materializes (THE PRODUCTION BUG)', async () => {
    // entitlement.state is 'approved_workspace' -- but for OWN_WS, not for ORG. The per-pair question
    // "is this user a member of ORG?" is still NO. The old precondition read the per-user GLOBAL state
    // and skipped the branch entirely, which is why production had ZERO materialized memberships.
    const r = await callSession({
      claims: ACCEPTED_MEMBER_CLAIMS,
      entitlements: [OWNS_OTHER_WORKSPACE, MEMBER_OF_ORG],
      sqlSeq: [[{ id: ORG }], [], [{ status: 'approved' }], [{ id: USER }]],
    });
    expect(r.status).toBe(200);
    expect(r.materializeCalls).toHaveLength(1);
    expect(r.materializeCalls[0]).toMatchObject({ workspaceId: ORG, userId: USER, role: 'viewer' });
    expect(r.transaction).toHaveBeenCalledTimes(1);
    expect(r.body.invite_materialized_role).toBe('viewer');
    expect(r.body.workspace?.id).toBe(ORG);
  });

  it('2b · already an ACTIVE member of the invited org -> no redundant materialization attempt', async () => {
    // The per-pair answer is YES here (the gate resolved approved_workspace FOR ORG), so the widened
    // precondition must still short-circuit: widening WHEN it is called must not turn every
    // authenticated session into a membership write attempt.
    const r = await callSession({
      claims: ACCEPTED_MEMBER_CLAIMS,
      entitlements: [MEMBER_OF_ORG],
      sqlSeq: [],
    });
    expect(r.status).toBe(200);
    expect(r.materializeCalls).toHaveLength(0);
    expect(r.transaction).not.toHaveBeenCalled();
  });

  it('3 · invited but NOT yet accepted (no signed org claims) -> does NOT materialize', async () => {
    // Clerk withholds org_id/org_role until the invitation is accepted. Without that signature there
    // is no proof of an accepted invitation and no workspace to bind to -- the branch must not run.
    const r = await callSession({
      claims: { sub: USER, email: EMAIL }, // no org_id, no org_role
      entitlements: [NO_WORKSPACE],
      sqlSeq: [],
    });
    expect(r.status).toBe(200);
    expect(r.materializeCalls).toHaveLength(0);
    expect(r.transaction).not.toHaveBeenCalled();
    expect(r.body.invite_materialized_role).toBeUndefined();
    expect(r.body.state).toBe('authenticated_no_access');
  });

  it('4 · AMBIGUOUS identity (>1 users row for the email) -> REFUSES with an explicit reason', async () => {
    // Production has 4 users rows and exactly 1 duplicated email (2 rows). Ambiguous identity must
    // never silently bind a customer workspace to the wrong one of two rows -- fail closed, say why.
    const r = await callSession({
      claims: ACCEPTED_MEMBER_CLAIMS,
      entitlements: [NO_WORKSPACE],
      sqlSeq: [[{ id: ORG }], [], [{ status: 'approved' }], [{ id: 'user_a' }, { id: 'user_b' }]],
    });
    expect(r.status).toBe(200);
    expect(r.materializeCalls).toHaveLength(1);   // it WAS attempted
    expect(r.transaction).not.toHaveBeenCalled(); // and refused BEFORE any write
    expect(r.body.invite_materialization_skipped_reason).toBe('identity_ambiguous');
    expect(r.body.invite_materialized_role).toBeUndefined();
  });
});
