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
