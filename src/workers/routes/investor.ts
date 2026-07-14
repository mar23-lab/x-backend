// investor.ts · Investor portal endpoints (Wave R-I.7 Stage C)
//
// Authority: migrations/0004_investor_portal_stage_c.sql + DR-11/12/13/14 operator decisions
//
// This file exports THREE Hono routers; index.ts mounts each under the appropriate auth gate:
//   - investorPublicRoute  → mounted under app (no auth)
//   - investorAuthedRoute  → mounted under protectedRoutes (clerkAuth)
//   - investorAdminRoute   → mounted under adminRoutes (clerkAuth + requireAdmin)
//
// Endpoints:
//   POST /api/v1/investor/nda-accept              · public (investorPublicRoute)
//   POST /api/v1/investor/request-deck-download   · authed Tier-1+ (investorAuthedRoute)
//   POST /api/v1/admin/investor/tier-1-grant      · admin (investorAdminRoute)
//   POST /api/v1/admin/investor/tier-2-escalate   · admin (investorAdminRoute)
//   POST /api/v1/admin/investor/tier-2-revoke     · admin (investorAdminRoute)
//
// Operator decisions resolved (Wave R-I.7 Stage B 2026-05-28):
//   DR-11: manual approval only (no auto-allowlist) — admin gates every entitlement
//   DR-12: typed-name NDA at registration (no DocuSign, no click-through)
//   DR-13: same NDA covers Tier-2 (single signature at registration)
//   DR-14: full ops-live-stream + 12 sections READY-filtered by default + welcome screen

import { Hono } from 'hono';
import { envFlagTrue } from '../lib/env-flag';
import { errorEnvelope } from '../middleware/error';
import type { DalAdapter } from '../dal/DalAdapter';
import type { CorsEnv } from '../middleware/cors';

export interface InvestorEnv extends CorsEnv {
  DATABASE_URL: string;
  /** R2 / asset URL for the canonical pitch deck PDF. */
  PITCH_DECK_URL?: string;
  /** e.g. '250905_v1' (post-pivot canonical). */
  PITCH_DECK_VERSION?: string;
  /** Phase 2 magic-link: Clerk secret (already used by auth middleware). */
  CLERK_SECRET_KEY?: string;
  /** Phase 2 feature flag: when 'true', tier-1-grant sends a Clerk invitation (magic-link email). */
  CLERK_INVITATIONS_ENABLED?: string;
  /** Where the magic-link returns the investor after sign-in. */
  INVESTOR_PORTAL_REDIRECT_URL?: string;
}

/**
 * Phase 2 (Wave R-I.7 Stage C) · send a Clerk invitation (magic-link email) to an
 * approved investor. No-op (returns null) unless CLERK_INVITATIONS_ENABLED==='true'
 * AND CLERK_SECRET_KEY is set — so this is safe to ship before keys are configured.
 * See docs/CLERK_MAGIC_LINK_SETUP.md.
 */
async function sendClerkInvitation(env: InvestorEnv, email: string, tier: 'tier-1' | 'tier-2'): Promise<{ ok: boolean; detail: string }> {
  if (!envFlagTrue(env.CLERK_INVITATIONS_ENABLED) || !env.CLERK_SECRET_KEY || !email) {
    return { ok: false, detail: 'clerk_invitations_disabled_or_unconfigured' };
  }
  try {
    const res = await fetch('https://api.clerk.com/v1/invitations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.CLERK_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email_address: email,
        public_metadata: { investor_tier: tier },
        redirect_url: env.INVESTOR_PORTAL_REDIRECT_URL || 'https://app.xlooop.com/?screen=investor-welcome',
        notify: true,
        ignore_existing: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, detail: 'clerk_invitation_http_' + res.status + (body ? ': ' + body.slice(0, 160) : '') };
    }
    return { ok: true, detail: 'clerk_invitation_sent' };
  } catch (err) {
    return { ok: false, detail: 'clerk_invitation_error: ' + (err instanceof Error ? err.message : String(err)) };
  }
}

export type InvestorVariables = {
  request_id: string;
  dal: DalAdapter;
  user_id?: string;
  user_email?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTER — investorPublicRoute
// Mounted under app.route('/api/v1', investorPublicRoute) in index.ts (no auth).
// ─────────────────────────────────────────────────────────────────────────────
export const investorPublicRoute = new Hono<{
  Bindings: InvestorEnv;
  Variables: InvestorVariables;
}>();

investorPublicRoute.post('/investor/nda-accept', async (ctx) => {
  try {
    const body = (await ctx.req.json().catch(() => null)) as {
      access_request_id?: string;
      email?: string;
      full_name_typed?: string;
      nda_version?: string;
    } | null;

    if (!body || typeof body !== 'object') {
      ctx.status(400);
      return ctx.json({ error: 'request body must be a JSON object', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }

    const accessRequestId = typeof body.access_request_id === 'string' ? body.access_request_id.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const fullName = typeof body.full_name_typed === 'string' ? body.full_name_typed.trim() : '';
    const ndaVersion = (typeof body.nda_version === 'string' && body.nda_version.trim()) || 'NDA_v1';

    if (!accessRequestId) {
      ctx.status(400);
      return ctx.json({ error: 'access_request_id is required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      ctx.status(400);
      return ctx.json({ error: 'valid email is required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    if (!fullName || fullName.length < 2 || fullName.length > 200) {
      ctx.status(400);
      return ctx.json({ error: 'full_name_typed required (2-200 characters)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }

    const ipAddress =
      ctx.req.header('cf-connecting-ip') ||
      ctx.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      null;
    const userAgent = ctx.req.header('user-agent') || null;

    const dal = ctx.get('dal');
    const acceptance = await dal.recordNdaAcceptance({
      access_request_id: accessRequestId,
      email,
      full_name_typed: fullName,
      nda_version: ndaVersion,
      ip_address: ipAddress,
      user_agent: userAgent,
    });

    ctx.status(202);
    return ctx.json({
      acceptance_id: acceptance.id,
      access_request_id: accessRequestId,
      email,
      nda_version: ndaVersion,
      accepted_at: acceptance.accepted_at,
      message: 'NDA acceptance recorded. Operator review pending (DR-11 manual approval).',
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHED ROUTER — investorAuthedRoute
// Mounted under userRoutes (clerkAuth({ requireOrg: false }) applied at parent).
// ─────────────────────────────────────────────────────────────────────────────
export const investorAuthedRoute = new Hono<{
  Bindings: InvestorEnv;
  Variables: InvestorVariables;
}>();

// GET /api/v1/me/investor-entitlement
// Phase 2 (Wave R-I.7 Stage C): server-validated tier check for InvestorAccessGate.
// InvestorAccessGate reads from Clerk JWT public_metadata (fast, synchronous) but
// the admin grant may not have updated Clerk metadata if CLERK_SECRET_KEY was not
// configured. This endpoint reads from the DB and provides the authoritative answer.
// Returns { tier, granted_at, scope_project_ref } or { tier: 'anonymous' }.
investorAuthedRoute.get('/me/investor-entitlement', async (ctx) => {
  try {
    const userId = ctx.get('user_id');
    if (!userId) {
      ctx.status(401);
      return ctx.json({ error: 'authentication required', code: 'UNAUTHENTICATED', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const entitlement = await dal.getInvestorEntitlement(userId);
    if (!entitlement) {
      return ctx.json({ tier: 'anonymous', message: 'No investor entitlement found.', request_id: ctx.get('request_id') });
    }
    return ctx.json({
      tier: entitlement.tier,
      granted_at: entitlement.granted_at,
      scope_project_ref: entitlement.scope_project_ref,
      request_id: ctx.get('request_id'),
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

investorAuthedRoute.post('/investor/request-deck-download', async (ctx) => {
  try {
    const userId = ctx.get('user_id');
    if (!userId) {
      ctx.status(401);
      return ctx.json({ error: 'authentication required', code: 'UNAUTHENTICATED', request_id: ctx.get('request_id') });
    }

    const dal = ctx.get('dal');
    const entitlement = await dal.getInvestorEntitlement(userId);
    if (!entitlement || (entitlement.tier !== 'tier-1' && entitlement.tier !== 'tier-2')) {
      ctx.status(403);
      return ctx.json({ error: 'Tier-1 investor entitlement required', code: 'FORBIDDEN_TIER_GATE', request_id: ctx.get('request_id') });
    }

    const deckUrl = ctx.env.PITCH_DECK_URL || '/assets/pitch-deck.pdf';
    const deckVersion = ctx.env.PITCH_DECK_VERSION || '250905_v1';

    ctx.status(200);
    return ctx.json({
      deck_url: deckUrl,
      deck_version: deckVersion,
      tier: entitlement.tier,
      ttl_seconds: 300,
      message: 'Download authorised. URL valid for 5 minutes.',
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTER — investorAdminRoute
// Mounted under adminRoutes (clerkAuth + requireAdmin applied at parent).
// All three endpoints require admin role.
// ─────────────────────────────────────────────────────────────────────────────
export const investorAdminRoute = new Hono<{
  Bindings: InvestorEnv;
  Variables: InvestorVariables;
}>();

investorAdminRoute.post('/investor/tier-1-grant', async (ctx) => {
  try {
    const adminUserId = ctx.get('user_id');
    if (!adminUserId) {
      ctx.status(401);
      return ctx.json({ error: 'authentication required', code: 'UNAUTHENTICATED', request_id: ctx.get('request_id') });
    }

    const body = (await ctx.req.json().catch(() => null)) as {
      access_request_id?: string;
      clerk_user_id?: string;
      email?: string;
    } | null;

    const accessRequestId = body?.access_request_id?.trim();
    const clerkUserId = body?.clerk_user_id?.trim();
    // HR-INPUT-COERCION-NO-THROW-1: `body?.email?.trim()` short-circuits to undefined,
    // then `.toLowerCase()` on undefined throws a 500. Guard on typeof (cf. line 110 / request-access.ts:67).
    const emailRaw = body?.email;
    const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';

    if (!accessRequestId && !clerkUserId) {
      ctx.status(400);
      return ctx.json({
        error: 'either clerk_user_id (preferred — Clerk user_id of the investor after they sign up via invite) or access_request_id must be provided',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }

    const dal = ctx.get('dal');
    const entitlement = await dal.grantInvestorTier1({
      access_request_id: accessRequestId,
      clerk_user_id: clerkUserId,
      email,
      granted_by: adminUserId,
    });

    // Phase 2 · Update Clerk public_metadata so the investor's JWT carries investor_tier.
    // InvestorAccessGate reads `session.user.public_metadata.investor_tier` — without this
    // update the gate always sees 'anonymous'. Non-fatal if Clerk API is unreachable.
    let clerkMetaUpdated = false;
    if (clerkUserId && ctx.env.CLERK_SECRET_KEY) {
      try {
        const clerkRes = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}/metadata`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${ctx.env.CLERK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ public_metadata: { investor_tier: 'tier-1' } }),
        });
        clerkMetaUpdated = clerkRes.ok;
      } catch (_) { /* non-fatal — portal falls back to GET /me/investor-entitlement */ }
    }

    // Phase 2 · send the Clerk magic-link invitation (no-op until flag+key set).
    const invite = await sendClerkInvitation(ctx.env, email || (entitlement as { email?: string })?.email || '', 'tier-1');

    ctx.status(201);
    return ctx.json({
      entitlement,
      invitation: invite,
      clerk_metadata_updated: clerkMetaUpdated,
      message: invite.ok
        ? 'Tier-1 granted; Clerk metadata updated; magic-link invitation emailed to the investor.'
        : 'Tier-1 entitlement granted; investor can download pitch deck. (Magic-link invitation not sent: ' + invite.detail + ' — see docs/CLERK_MAGIC_LINK_SETUP.md.)',
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

investorAdminRoute.post('/investor/tier-2-escalate', async (ctx) => {
  try {
    const adminUserId = ctx.get('user_id');
    if (!adminUserId) {
      ctx.status(401);
      return ctx.json({ error: 'authentication required', code: 'UNAUTHENTICATED', request_id: ctx.get('request_id') });
    }

    const body = (await ctx.req.json().catch(() => null)) as {
      user_id?: string;
      section_filter?: { mode: 'all-ready' | 'operator-curated' | 'specific-sections'; sections?: string[] };
      reason?: string;
    } | null;

    const targetUserId = body?.user_id?.trim();
    if (!targetUserId) {
      ctx.status(400);
      return ctx.json({ error: 'user_id is required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }

    const dal = ctx.get('dal');
    const entitlement = await dal.escalateInvestorToTier2({
      user_id: targetUserId,
      escalated_by: adminUserId,
      section_filter: body?.section_filter || { mode: 'all-ready' },
      reason: body?.reason,
    });

    ctx.status(200);
    return ctx.json({ entitlement, message: 'Investor escalated to Tier-2; full data-room view granted (READY-filtered).' });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

investorAdminRoute.post('/investor/tier-2-revoke', async (ctx) => {
  try {
    const adminUserId = ctx.get('user_id');
    if (!adminUserId) {
      ctx.status(401);
      return ctx.json({ error: 'authentication required', code: 'UNAUTHENTICATED', request_id: ctx.get('request_id') });
    }

    const body = (await ctx.req.json().catch(() => null)) as { user_id?: string; reason?: string } | null;
    const targetUserId = body?.user_id?.trim();
    if (!targetUserId) {
      ctx.status(400);
      return ctx.json({ error: 'user_id is required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }

    const dal = ctx.get('dal');
    const entitlement = await dal.revokeInvestorTier2({
      user_id: targetUserId,
      revoked_by: adminUserId,
      reason: body?.reason,
    });

    ctx.status(200);
    return ctx.json({ entitlement, message: 'Investor demoted to Tier-1; data-room access removed.' });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
