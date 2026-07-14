// customer.ts · POST /api/v1/customer/authority-consent · workspace-scoped (requires org)
//
// Authority: CUSTOMER_ECOSYSTEM_ONBOARDING_AND_IP_BOUNDARY_STANDARD §Authority Gate
//
// The in-app typed-name authority/consent acknowledgement that UNLOCKS private connectors +
// team invites. This is the CUSTOMER side of the authority record; the OPERATOR side is
// recorded at approval (DR-11 manual). Mirrors the investor typed-name NDA pattern (DR-12):
// a typed full legal name has the same effect as a handwritten signature under the Electronic
// Transactions Act 1999 (Cth). Connectors stay 403 AUTHORITY_REQUIRED until BOTH sides exist.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { createTeamInvitation } from '../services/clerk-org';
import { authorizeGovernedWrite } from '../lib/spine-authority';

export interface CustomerRoutesEnv extends AuthEnv {
  DATABASE_URL: string;
  // W1b · operator identity set — when the consenter is the operator (their OWN org), the
  // operator-approval side is auto-recorded so operator-owned workspaces unlock self-serve.
  MBP_OWNER_USER_ID?: string;
  MBP_OWNER_LINKED_USER_IDS?: string;
  // W4/G2 · explicit allowlist of operator-owned org ids — the precise scope for auto-approve
  // (preferred over the consenter-is-operator heuristic when set). Comma-separated org_ ids.
  OPERATOR_WORKSPACE_IDS?: string;
}

export type CustomerRoutesVariables = AuthVariables & {
  dal: DalAdapter;
};

export const customerRoute = new Hono<{
  Bindings: CustomerRoutesEnv;
  Variables: CustomerRoutesVariables;
}>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

customerRoute.post('/customer/authority-consent', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    if (!auth.workspace_id) {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'a workspace (organization) is required to record authority consent',
      });
    }

    const body = (await ctx.req.json().catch(() => ({}))) as {
      full_name_typed?: string;
      scopes_confirmed?: Record<string, unknown>;
      access_request_id?: string;
      company?: string;
    };
    const fullName = (body.full_name_typed || '').trim();
    if (fullName.length < 2 || fullName.length > 200) {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'full_name_typed (2-200 chars) is required',
      });
    }

    const ipAddress =
      ctx.req.header('cf-connecting-ip') ||
      ctx.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      null;
    const userAgent = ctx.req.header('user-agent') || null;

    const dal = ctx.get('dal');
    await dal.recordCustomerConsentAck({
      workspace_id: auth.workspace_id,
      user_id: auth.user_id,
      full_name_typed: fullName,
      access_request_id: typeof body.access_request_id === 'string' ? body.access_request_id : null,
      scopes_confirmed:
        body.scopes_confirmed && typeof body.scopes_confirmed === 'object' ? body.scopes_confirmed : {},
      ip_address: ipAddress,
      user_agent: userAgent,
      // W1b · identity bundle: trusted email from the JWT + optional self-reported company.
      email: auth.email ?? null,
      company: typeof body.company === 'string' && body.company.trim() ? body.company.trim() : null,
    });

    // W1b/W4 · auto-approve the operator-approval side for OPERATOR-OWNED orgs. The operator IS the
    // authority for their own workspaces, so a separate manual approval (DR-11) there is friction with
    // no IP-boundary value — connecting your own Drive to your own org shouldn't dead-end. Real
    // CUSTOMER orgs are NEVER auto-approved: they require explicit operator approval
    // (POST /admin/customer/:id/approve). W4/G2 tightens the scope: prefer the explicit
    // OPERATOR_WORKSPACE_IDS allowlist (the org ids the operator owns); fall back to the W1b
    // consenter-is-operator heuristic only when the allowlist is unset (backwards-compat).
    const operatorIds = [
      String(ctx.env.MBP_OWNER_USER_ID || '').trim(),
      ...String(ctx.env.MBP_OWNER_LINKED_USER_IDS || '').split(',').map((s) => s.trim()),
    ].filter(Boolean);
    const operatorWorkspaceIds = String(ctx.env.OPERATOR_WORKSPACE_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const autoApproveOwnOrg = operatorWorkspaceIds.length
      ? operatorWorkspaceIds.includes(auth.workspace_id)   // explicit allowlist (precise; W4)
      : operatorIds.includes(auth.user_id);                // consenter-is-operator fallback (W1b)
    if (autoApproveOwnOrg && typeof dal.recordOperatorAuthority === 'function') {
      try {
        await dal.recordOperatorAuthority({
          workspace_id: auth.workspace_id,
          operator_user_id: auth.user_id,
        });
      } catch (_) {
        // best-effort; the customer-side consent is already recorded
      }
    }

    const state = await dal.getCustomerAuthorityState(auth.workspace_id);
    ctx.status(202);
    return ctx.json({
      acknowledged: true,
      authority: {
        unlocked: state.unlocked,
        operator_approved: state.operator_approved,
        consent_acked: state.consent_acked,
      },
      message: state.unlocked
        ? 'Consent recorded. Connectors and team invites are now unlocked.'
        : 'Consent recorded. Awaiting operator approval before connectors and team invites unlock.',
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// Lifecycle L1 · GET /api/v1/customer/authority-consent · workspace-scoped (requires org)
//
// Read the caller workspace's live authority/consent state for the "Workspace authority" view
// (AccountScreens). Returns a CURATED projection (no ip_address/user_agent/raw metadata) plus a
// can_revoke flag derived from the caller's role — so the UI shows the revoke affordance only to an
// owner/operator (the server still enforces it on POST). Read-only; never mutates.
customerRoute.get('/customer/authority-consent', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    if (!auth.workspace_id) {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'a workspace (organization) is required to read authority consent',
      });
    }
    const dal = ctx.get('dal');
    const state = await dal.getCustomerAuthorityState(auth.workspace_id);
    const c = state.consent;
    const canRevoke = auth.role === 'owner' || auth.role === 'operator';
    return ctx.json({
      workspace_id: auth.workspace_id,
      authority: {
        unlocked: state.unlocked,
        operator_approved: state.operator_approved,
        consent_acked: state.consent_acked,
      },
      consent: c
        ? {
            full_name_typed: c.full_name_typed,
            consent_acked_at: c.consent_acked_at,
            consent_acked_by: c.consent_acked_by,
            consent_version: c.consent_version,
            scopes_confirmed: c.scopes_confirmed,
            operator_approved_at: c.operator_approved_at,
            operator_approved_by: c.operator_approved_by,
          }
        : null,
      can_revoke: canRevoke,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// Lifecycle L1 · POST /api/v1/customer/authority-consent/revoke · workspace-scoped (requires org)
//
// In-app WITHDRAWAL of the workspace's authority/consent. Re-locks private connectors + team
// invites (the same IP-boundary gate the ack unlocked). Symmetric with the typed-name e-signature:
// the caller re-types their full legal name to confirm (intent-to-revoke evidence, mirroring the
// Electronic Transactions Act provenance pattern used on the consent ack). Owner/operator only —
// a viewer cannot revoke. NEVER hard-deletes: sets revoked_at on the active row (immutable
// supersede); a later connect re-routes to the consent screen (403 AUTHORITY_REQUIRED → W1a),
// which upserts a fresh active row. Audit-logged best-effort (the consent row itself is the
// primary durable record via revoked_by/revoked_at/revoked_reason).
customerRoute.post('/customer/authority-consent/revoke', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    if (!auth.workspace_id) {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'a workspace (organization) is required to revoke authority consent',
      });
    }
    if (!(await authorizeGovernedWrite(ctx, 'authority:revoke')).allowed) {
      return errorEnvelope(ctx, {
        status: 403,
        code: 'FORBIDDEN',
        message: 'only the workspace owner or an operator can revoke workspace authority',
      });
    }

    const body = (await ctx.req.json().catch(() => ({}))) as {
      full_name_typed?: string;
      reason?: string;
    };
    const fullName = (body.full_name_typed || '').trim();
    if (fullName.length < 2 || fullName.length > 200) {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'full_name_typed (2-200 chars) is required to confirm revocation',
      });
    }
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;

    const dal = ctx.get('dal');
    // The DAL records the revoke + the audit_logs entry transactionally in one atomic statement
    // (the audit can't silently fail post-revoke, and never logs a no-op). 404 if no active row.
    await dal.revokeCustomerAuthority({
      workspace_id: auth.workspace_id,
      revoked_by: auth.user_id,
      revoked_reason: reason,
      re_attest_name: fullName,
    });

    const state = await dal.getCustomerAuthorityState(auth.workspace_id);
    return ctx.json({
      revoked: true,
      authority: {
        unlocked: state.unlocked,
        operator_approved: state.operator_approved,
        consent_acked: state.consent_acked,
      },
      message:
        'Workspace authority revoked. Connectors and team invites are locked. Reconnecting a source will ask you to re-authorize.',
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/customer/invites · workspace-scoped (requires org) · R55 Phase 4b
// Invite a teammate to the workspace's Clerk organization. Hard-gated on the IP-boundary
// authority record (operator approval + customer consent ack) AND caller role (owner/operator).
// Clerk owns the pending-invite state; a workspace_members row is created when the invitee
// accepts + signs in (existing onboarding/session flow).
customerRoute.post('/customer/invites', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    if (!auth.workspace_id) {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'a workspace (organization) is required to invite teammates',
      });
    }
    if (!(await authorizeGovernedWrite(ctx, 'member:invite')).allowed) {
      return errorEnvelope(ctx, {
        status: 403,
        code: 'FORBIDDEN',
        message: 'only the workspace owner or an operator can invite teammates',
      });
    }

    // IP-boundary hard-gate: team invites stay locked until operator approval + consent ack
    // (CUSTOMER_ECOSYSTEM_ONBOARDING_AND_IP_BOUNDARY_STANDARD). Same predicate as connectors.
    const dal = ctx.get('dal');
    const authority = await dal.getCustomerAuthorityState(auth.workspace_id);
    if (!authority.unlocked) {
      return errorEnvelope(ctx, {
        status: 403,
        code: 'FORBIDDEN',
        message: 'AUTHORITY_REQUIRED: inviting teammates is locked until your workspace authority and consent are recorded.',
      });
    }

    const body = (await ctx.req.json().catch(() => ({}))) as { email?: string; role?: string };
    const email = (body.email || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'a valid invitee email is required' });
    }
    // Map the requested workspace role to a Clerk org role (default: member).
    const clerkRole =
      body.role === 'owner' || body.role === 'operator' || body.role === 'admin' ? 'org:admin' : 'org:member';

    const result = await createTeamInvitation(ctx.env.CLERK_SECRET_KEY, {
      organizationId: auth.workspace_id,
      inviterUserId: auth.user_id,
      emailAddress: email,
      role: clerkRole,
    });

    ctx.status(201);
    return ctx.json({ invited: result, message: `Invitation sent to ${email}.` });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
