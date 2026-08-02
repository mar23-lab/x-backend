// customer-invites.ts · governed workspace invitation route handler

import type { Context } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { createTeamInvitation, findTeamInvitationByCommandId } from '../services/clerk-org';
import { authorizeGovernedWrite } from '../lib/spine-authority';
import type { CustomerRoutesEnv, CustomerRoutesVariables } from './customer';

type CustomerContext = Context<{
  Bindings: CustomerRoutesEnv;
  Variables: CustomerRoutesVariables;
}>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Domains where a shared suffix says nothing about a shared employer. Used ONLY to disqualify the
// same-domain colleague inference in POST /customer/invites — see the block at its use site for the
// production audit rows that made this necessary. Never used to reject an address: a Gmail invitee
// is perfectly valid, they simply arrive at the conservative 'client' role instead of operator.
//
// A denylist ages, and a missed provider silently restores the elevation. That is why this is the
// FIRST of three steps, not the fix: the durable answer is a verified per-workspace domain
// (workspaces.config, already jsonb and empty for both external tenants), with this list retired.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.com.au', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'mail.ru', 'inbox.com',
  'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'fastmail.fm',
  'tutanota.com', 'tuta.io', 'hey.com', 'hushmail.com', 'zohomail.com',
  'qq.com', '163.com', '126.com', 'sina.com', 'naver.com', 'daum.net',
  'web.de', 't-online.de', 'orange.fr', 'free.fr', 'laposte.net',
  'bigpond.com', 'optusnet.com.au', 'iinet.net.au', 'tpg.com.au',
]);

export async function handleCustomerInvite(ctx: CustomerContext): Promise<Response> {
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

    const idempotencyKey = String(ctx.req.header('Idempotency-Key') || '').trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return errorEnvelope(ctx, {
        status: 428,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key is required to invite a workspace member (1-200 chars)',
      });
    }
    const rawBody = await ctx.req.text();
    let body: { email?: string; role?: string } = {};
    try {
      body = JSON.parse(rawBody) as { email?: string; role?: string };
    } catch {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'request body must be valid JSON' });
    }
    const email = (body.email || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'a valid invitee email is required' });
    }
    if (body.role != null && typeof body.role !== 'string') {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'role must be a string',
      });
    }
    const requestedBodyRole = (body.role || 'client').trim().toLowerCase();
    if (!['owner', 'operator', 'admin', 'viewer', 'client'].includes(requestedBodyRole)) {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'role must be owner, operator, admin, viewer, or client',
      });
    }
    // Role inference is server-side because the inviter identity is JWT-trusted. Matching
    // corporate domains may default to operator, while public mail providers remain viewer by
    // default because a shared provider domain does not prove an employment relationship.
    const inviterDomain = String(auth.email || '').split('@')[1]?.trim().toLowerCase() || '';
    const inviteeDomain = email.split('@')[1]?.trim().toLowerCase() || '';
    const sameDomainAsInviter =
      !!inviterDomain &&
      inviterDomain === inviteeDomain &&
      !PUBLIC_EMAIL_DOMAINS.has(inviterDomain);
    const explicitElevated =
      requestedBodyRole === 'owner' || requestedBodyRole === 'operator' || requestedBodyRole === 'admin';
    const clerkRole = explicitElevated || sameDomainAsInviter ? 'org:admin' : 'org:member';
    const workspaceRole = clerkRole === 'org:admin' ? 'operator' : 'viewer';
    const roleBasis = explicitElevated
      ? 'explicit_elevated'
      : sameDomainAsInviter
        ? 'same_non_public_domain'
        : body.role
          ? 'explicit_restricted'
          : 'conservative_default';

    const route = 'POST /api/v1/customer/invites' as const;
    const requestSha256 = await sha256Text(
      `POST\n${auth.workspace_id}\n${auth.user_id}\n${rawBody}`,
    );
    const leaseToken = crypto.randomUUID();
    const reservation = await dal.reserveCustomerInvite({
      workspace_id: auth.workspace_id,
      actor_user_id: auth.user_id,
      key: idempotencyKey,
      route,
      request_sha256: requestSha256,
      request_id: ctx.get('request_id') || null,
      command_id: crypto.randomUUID(),
      lease_token: leaseToken,
      email,
      clerk_role: clerkRole,
      workspace_role: workspaceRole,
      requested_workspace_role: requestedBodyRole,
      role_basis: roleBasis,
    });
    if (reservation.state === 'delivered' && reservation.receipt) {
      ctx.header('Idempotency-Replayed', 'true');
      ctx.status(201);
      return ctx.json({
        ...reservation.receipt,
        replayed: true,
        message: `Invitation already delivered to ${reservation.receipt.invited.email}.`,
      });
    }
    if (!reservation.lease_token || !reservation.command) {
      throw { status: 500, code: 'INVITE_ATOMICITY_FAILED', message: 'invitation delivery lease is incomplete' };
    }

    const command = reservation.command;
    try {
      const recovered = reservation.reconcile_provider
        ? await findTeamInvitationByCommandId(
            ctx.env.CLERK_SECRET_KEY,
            auth.workspace_id,
            reservation.command_id,
          )
        : null;
      const result = recovered ?? await createTeamInvitation(ctx.env.CLERK_SECRET_KEY, {
        organizationId: auth.workspace_id,
        inviterUserId: auth.user_id,
        emailAddress: command.email,
        role: command.clerk_role,
        commandId: reservation.command_id,
      });
      const receipt = await dal.finalizeCustomerInvite({
        workspace_id: auth.workspace_id,
        actor_user_id: auth.user_id,
        key: idempotencyKey,
        route,
        request_sha256: requestSha256,
        request_id: ctx.get('request_id') || null,
        command_id: reservation.command_id,
        lease_token: reservation.lease_token,
        email: command.email,
        clerk_role: result.role || command.clerk_role,
        workspace_role: command.workspace_role,
        requested_workspace_role: command.requested_workspace_role,
        role_basis: command.role_basis,
        invitation_id: result.invitation_id,
        provider_status: result.status,
        operation_event_id: crypto.randomUUID(),
        projection_outbox_id: crypto.randomUUID(),
      });
      if (receipt.replayed) ctx.header('Idempotency-Replayed', 'true');
      ctx.status(201);
      return ctx.json({
        ...receipt,
        message: recovered
          ? `Invitation delivery confirmed for ${command.email}.`
          : `Invitation sent to ${command.email}.`,
      });
    } catch (err) {
      const failure = err as { code?: string };
      try {
        await dal.recordCustomerInviteDeliveryFailure({
          workspace_id: auth.workspace_id,
          actor_user_id: auth.user_id,
          key: idempotencyKey,
          route,
          request_sha256: requestSha256,
          request_id: ctx.get('request_id') || null,
          command_id: reservation.command_id,
          lease_token: reservation.lease_token,
          email: command.email,
          error_code: failure.code || 'INVITE_DELIVERY_FAILED',
          operation_event_id: crypto.randomUUID(),
        });
      } catch (recordError) {
        console.error('customer invite failure ledger unavailable', {
          request_id: ctx.get('request_id') || null,
          workspace_id: auth.workspace_id,
          error_code: (recordError as { code?: string }).code || 'INVITE_FAILURE_LEDGER_UNAVAILABLE',
        });
      }
      throw err;
    }
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
}
