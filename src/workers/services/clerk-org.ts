// services/clerk-org.ts · Clerk Organizations wrapper for customer team invites (R55 · Phase 4b)
//
// Authority: CUSTOMER_ECOSYSTEM_ONBOARDING_AND_IP_BOUNDARY_STANDARD §team invite (hard-gated).
// Isolates the @clerk/backend organization API so routes/customer.ts stays policy-only,
// mirroring the makeClerkOAuthAdapter pattern in dal/clerk-oauth-adapter.ts.
//
// Clerk owns the PENDING-invite state (keyed by email). A workspace_members row is created
// when the invitee accepts + signs in (existing onboarding/session flow) — NOT at invite time,
// because the invitee has no user_id yet. Never call this without first checking the authority
// gate: getCustomerAuthorityState(workspace_id).unlocked.

import { createClerkClient } from '@clerk/backend';

interface ClerkOrgError extends Error {
  code: string;
  status: number;
}

function clerkOrgError(code: string, message: string, status: number): ClerkOrgError {
  const err = new Error(message) as ClerkOrgError;
  err.code = code;
  err.status = status;
  return err;
}

/**
 * One accepted Clerk organization membership for a user.
 *
 * A5 Option B (260731). The invite→membership seam is driven by the `org_id`/`org_role` JWT claims,
 * which Clerk emits ONLY when the session has an ACTIVE organization. A user who belongs to several
 * organizations therefore has exactly one of them represented in any given token — every other
 * accepted membership is invisible to the session route, and its `workspace_members` row is never
 * written.
 *
 * Measured on production 2026-07-31: Clerk showed Honest & Young with 3 members and one operator
 * account ACCEPTED since 07-29, while `workspace_members` held ONE row and
 * `activated_by='invite-materialization'` was 0 across the whole table. The operator signed out and
 * back in twice; the client-side auto-activate (most-recently-joined) shipped and still produced no
 * row, because for a user with 8 other organizations "most recently joined" is not reliably the one
 * they were invited to. The client path cannot close this on its own.
 *
 * This is the server-side backstop the plan named as Option B: ask Clerk directly which
 * organizations the authenticated user actually belongs to, instead of depending on which one
 * happened to be active when the token was minted.
 */
export interface UserOrgMembership {
  organizationId: string;
  role: string; // Clerk org role, e.g. 'org:member' | 'org:admin'
}

/**
 * List the authenticated user's accepted organization memberships.
 *
 * FAIL-OPEN BY CONTRACT. Every caller is on a session hot path whose current behaviour is "no
 * membership materialized". If Clerk is unreachable, slow, or returns an unexpected shape, the
 * right outcome is that same current behaviour — never a failed sign-in. So this returns an EMPTY
 * LIST on any error rather than throwing: a degraded Clerk must not be able to lock users out of a
 * product they are already entitled to use.
 *
 * That is a deliberate inversion of the usual fail-closed rule in this repo, and it is safe here
 * for one specific reason: this function only ever ADDS a membership the user has already accepted
 * in Clerk. It cannot grant access Clerk has not already granted, so an empty result is strictly
 * less privilege, never more.
 */
export async function listUserOrgMemberships(
  secretKey: string,
  userId: string,
  opts: { limit?: number } = {}
): Promise<UserOrgMembership[]> {
  if (!secretKey || typeof secretKey !== 'string') return [];
  if (!userId || typeof userId !== 'string') return [];

  const limit = opts.limit ?? 50;

  try {
    const clerk = createClerkClient({ secretKey });
    const res = await clerk.users.getOrganizationMembershipList({ userId, limit });
    // The SDK has returned both a bare array and a paginated { data } envelope across versions;
    // accept either rather than pinning to one and silently reading zero memberships after an
    // upgrade — a silent zero here reproduces exactly the defect this function exists to fix.
    const rows = Array.isArray(res) ? res : ((res as { data?: unknown[] } | null)?.data ?? []);
    const out: UserOrgMembership[] = [];
    for (const m of rows as Array<{ organization?: { id?: unknown }; role?: unknown }>) {
      const organizationId = m?.organization?.id;
      const role = m?.role;
      if (typeof organizationId === 'string' && organizationId && typeof role === 'string' && role) {
        out.push({ organizationId, role });
      }
    }
    return out;
  } catch {
    // Intentionally swallowed — see the fail-open contract above. The caller records the skip
    // reason on the session envelope so the absence is observable without being fatal.
    return [];
  }
}

export interface TeamInvitationInput {
  organizationId: string;
  inviterUserId: string;
  emailAddress: string;
  role: string; // Clerk org role, e.g. 'org:member' | 'org:admin'
  redirectUrl?: string;
}

export interface TeamInvitationResult {
  invitation_id: string;
  email: string;
  role: string;
  status: string;
}

export async function createTeamInvitation(
  secretKey: string,
  input: TeamInvitationInput
): Promise<TeamInvitationResult> {
  if (!secretKey || typeof secretKey !== 'string') {
    throw clerkOrgError('CONFIG_ERROR', 'CLERK_SECRET_KEY is not configured', 500);
  }
  if (!input?.organizationId || !input?.emailAddress) {
    throw clerkOrgError('VALIDATION_ERROR', 'organizationId and emailAddress are required', 400);
  }
  const clerk = createClerkClient({ secretKey });
  try {
    const invitation = await clerk.organizations.createOrganizationInvitation({
      organizationId: input.organizationId,
      inviterUserId: input.inviterUserId,
      emailAddress: input.emailAddress,
      role: input.role,
      ...(input.redirectUrl ? { redirectUrl: input.redirectUrl } : {}),
    });
    return {
      invitation_id: invitation.id,
      email: invitation.emailAddress || input.emailAddress,
      role: invitation.role || input.role,
      status: invitation.status || 'pending',
    };
  } catch (err) {
    const e = err as { status?: number; errors?: Array<{ message?: string }>; message?: string };
    const message = e.errors?.[0]?.message || e.message || 'Clerk organization invitation failed';
    const status = typeof e.status === 'number' && e.status >= 400 ? e.status : 502;
    throw clerkOrgError('CLERK_ORG_ERROR', message, status);
  }
}
