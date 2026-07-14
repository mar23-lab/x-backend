// request-access.ts · POST /api/v1/request-access · public, no auth required
//
// Authority: AUTH_TENANCY_MODEL.md §Path B early adopter access request
//
// MUST NOT:
//   - Create product access
//   - Create active workspace membership
//   - Auto-provision a user
//
// MUST:
//   - Create an access_requests row (status='pending')
//   - Notify admin — WIRED via notifyAdminAccessRequest (services/email-notifier); the 202 body
//     surfaces its delivered/channel result (doc corrected 260711-J / ROUTE-03)
//   - Be idempotent on email (return existing pending row)
//   - Validate email format minimally
//   - Capture IP + user-agent for abuse triage
//
// Future hardening (not R40): rate-limit per IP, CAPTCHA, email verification.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { notifyAdminAccessRequest, type NotifierEnv } from '../services/email-notifier';
import { verifyTurnstile, type TurnstileEnv } from '../services/turnstile';
import type { DalAdapter } from '../dal/DalAdapter';
import type { AccessRequestInput } from '../dal/types';

export interface RequestAccessEnv extends NotifierEnv, TurnstileEnv {
  DATABASE_URL: string;
}

export type RequestAccessVariables = {
  request_id: string;
  dal: DalAdapter;
};

export const requestAccessRoute = new Hono<{
  Bindings: RequestAccessEnv;
  Variables: RequestAccessVariables;
}>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ACCOUNT_TYPES = new Set(['personal', 'company', 'both']);

// Coerce to a plain object and bound serialized size (defensive — this is a public endpoint).
function boundedRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  try {
    if (JSON.stringify(v).length > 20000) return { _truncated: true };
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

requestAccessRoute.post('/request-access', async (ctx) => {
  try {
    const body = (await ctx.req.json().catch(() => null)) as Partial<AccessRequestInput> | null;
    if (!body || typeof body !== 'object') {
      ctx.status(400);
      return ctx.json({
        error: 'request body must be a JSON object',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }

    // Validation
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      ctx.status(400);
      return ctx.json({
        error: 'valid email is required',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }

    // R56 Stage 1 · bot protection (Cloudflare Turnstile). Verification is gated on
    // TURNSTILE_SECRET: until the operator provisions it (after the x-web widget ships),
    // verifyTurnstile() returns ok+skipped so the funnel keeps working. Once set, a missing
    // or invalid token is rejected with 403. The per-IP rate-limit (index.ts) is the other layer.
    const clientIp =
      ctx.req.header('cf-connecting-ip') ||
      ctx.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      null;
    const turnstileToken =
      typeof (body as Record<string, unknown>).turnstile_token === 'string'
        ? ((body as Record<string, unknown>).turnstile_token as string)
        : null;
    const turnstile = await verifyTurnstile(ctx.env, turnstileToken, clientIp);
    if (!turnstile.ok) {
      ctx.status(403);
      return ctx.json({
        error: 'bot verification failed; please retry',
        code: 'TURNSTILE_FAILED',
        request_id: ctx.get('request_id'),
      });
    }
    if (turnstile.reason === 'siteverify_unreachable') {
      console.log(
        JSON.stringify({ kind: 'turnstile_siteverify_unreachable', request_id: ctx.get('request_id') })
      );
    }

    const companyName = typeof body.company_name === 'string'
      ? body.company_name.trim().slice(0, 200)
      : undefined;
    const reason = typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 2000)
      : undefined;
    const source = typeof body.source === 'string'
      ? body.source.trim().slice(0, 64)
      : 'web';

    // Capture client metadata for abuse triage
    const ipAddress =
      ctx.req.header('cf-connecting-ip') ||
      ctx.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      null;
    const userAgent = ctx.req.header('user-agent') || null;

    const input: AccessRequestInput = {
      email,
      ...(companyName ? { company_name: companyName } : {}),
      ...(reason ? { reason } : {}),
      ...(source ? { source } : {}),
      ...(ipAddress ? { ip_address: ipAddress } : {}),
      ...(userAgent ? { user_agent: userAgent } : {}),
    };

    const dal = ctx.get('dal');
    const accessRequest = await dal.createAccessRequest(input);

    // R55 · customer registration: if the readiness funnel sent the extended payload,
    // persist the Q&A + account type + public-signal enrichment. Best-effort — a persistence
    // failure must NEVER block the access request (the request row is already created).
    const b = body as Record<string, unknown>;
    const accountType =
      typeof b.account_type === 'string' && ALLOWED_ACCOUNT_TYPES.has(b.account_type)
        ? (b.account_type as 'personal' | 'company' | 'both')
        : null;
    const hasReadiness =
      !!accountType || b.readiness_answers != null || b.deep_level != null || b.enrichment != null;
    if (hasReadiness) {
      try {
        await dal.createReadinessAssessment({
          access_request_id: accessRequest.id,
          email: accessRequest.email,
          account_type: accountType ?? 'company',
          also_personal_space: b.also_personal_space === true,
          company_name: accessRequest.company_name,
          domain: typeof b.domain === 'string' ? b.domain.slice(0, 253) : null,
          country: typeof b.country === 'string' ? b.country.slice(0, 8) : null,
          deep_level:
            typeof b.deep_level === 'number' && Number.isInteger(b.deep_level) ? b.deep_level : null,
          readiness_answers: boundedRecord(b.readiness_answers) ?? {},
          deep_check: boundedRecord(b.deep_check),
          enrichment: boundedRecord(b.enrichment),
          consent: boundedRecord(b.consent) ?? {},
          source: accessRequest.source,
        });
      } catch (err) {
        console.log(
          JSON.stringify({
            kind: 'readiness_persist_error',
            request_id: accessRequest.id,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }

    // Part R · Stage B (260628): mark the lead registered-vs-anonymous in the operator email.
    // Best-effort — a lookup failure must never block the notification. A `users` row means the
    // person has a Clerk identity; its absence means an anonymous website lead (the operator's ask:
    // "notify even if not registered, mark not-registered").
    const existingUser = await dal.getUserByEmail(accessRequest.email).catch(() => null);

    // Best-effort notify (never throws — notifier returns delivered: false on failure)
    const notifyResult = await notifyAdminAccessRequest(ctx.env, {
      request_id: accessRequest.id,
      email: accessRequest.email,
      company_name: accessRequest.company_name,
      reason: accessRequest.reason,
      source: accessRequest.source,
      ip_address: accessRequest.ip_address,
      created_at: accessRequest.created_at,
      account_type: accountType,
      deep_level: typeof b.deep_level === 'number' ? b.deep_level : null,
      registered: !!existingUser,
    });

    ctx.status(202);
    return ctx.json({
      request_id: accessRequest.id,
      status: accessRequest.status,
      message: 'Access request received. An administrator will review it.',
      notification: {
        delivered: notifyResult.delivered,
        channel: notifyResult.channel,
      },
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
