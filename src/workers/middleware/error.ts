// error.ts · Centralized error handler · maps thrown errors to API error envelope
//
// Authority: API_CONTRACT_V1.md §Error envelope · Standard error codes

import { Context } from 'hono';
import type { ApiError, ApiErrorCode } from '../dal/types';
import { sentryInit, captureException } from '../sentry';

interface ThrownErrorLike {
  message: string;
  code?: string;
  status?: number;
  cause?: unknown;
}

const CODE_TO_STATUS: Record<string, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  // T1/P3 (260710) · source-connection contract codes (mirrored in ApiErrorCode, dal/types/auth.ts).
  // An unregistered code silently downgrades to INTERNAL_ERROR on the wire — that latent bug was hitting
  // SOURCE_WORKSPACE_BINDING_REQUIRED (sources.ts sync, R50); registering both keeps status AND wire code.
  SOURCE_WORKSPACE_BINDING_REQUIRED: 409,
  SOURCE_SCOPE_MISSING: 422,
};

export function errorEnvelope(
  ctx: Context,
  err: unknown
): Response {
  const requestId = (ctx.get('request_id') as string) || ctx.req.header('cf-ray') || '';

  const e: ThrownErrorLike = (err && typeof err === 'object') ? err as ThrownErrorLike : { message: String(err) };

  // EE-1 (J-W2 260711-I): PRESERVE the thrown code on the wire even when it isn't in CODE_TO_STATUS.
  // makeError(code,message,status) carries an explicit status, so the author's code was intentional —
  // silently rewriting any unregistered code to INTERNAL_ERROR hid the real failure (it was masking
  // SOURCE_WORKSPACE_BINDING_REQUIRED, SOURCE_SYNC_ERROR, and ~30 others). Status still resolves from
  // the explicit e.status, then CODE_TO_STATUS, then 500 — so registration is no longer load-bearing.
  const code: ApiErrorCode = (typeof e.code === 'string' && e.code ? e.code : 'INTERNAL_ERROR') as ApiErrorCode;
  const status = (typeof e.status === 'number' && e.status >= 400 && e.status < 600)
    ? e.status
    : (CODE_TO_STATUS[code] ?? 500);

  // A-W6 · SIEM/observability: a 5xx is a real server fault (a bug/dependency failure), not an expected
  // 4xx client error — capture it. Central chokepoint: every route funnels its errors through errorEnvelope
  // + app.onError, so this one hook covers the worker. Dormant-safe: sentryInit/captureException are no-ops
  // (console-fallback) until SENTRY_DSN is bound; PII is stripped by sentry.ts's beforeSend redaction.
  if (status >= 500) {
    try {
      sentryInit(ctx.env as { SENTRY_DSN?: string });
      captureException(err, { route: ctx.req?.path, request_id: requestId, status, code });
    } catch { /* observability must never break the error response */ }
  }

  // EE-2 / SEC-1 (J-W2 260711-I): a >=500 is a server fault whose raw message can leak DB/driver/schema
  // internals to the client. Ship a generic message on the wire; the FULL error already went to Sentry
  // above. Sub-500 client errors keep e.message (intentional validation/auth text the caller needs).
  const wireMessage = status >= 500 ? 'internal error' : (e.message || code);

  const payload: ApiError = {
    error: wireMessage,
    code,
    request_id: requestId,
  };

  // hono's ctx.json with status code
  ctx.status(status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503);
  return ctx.json(payload);
}

/**
 * EE-3 (J-W2 260711-I): the standard envelope for an INTENTIONAL early-return error (validation, auth,
 * config). Unlike errorEnvelope it does NOT capture to Sentry or genericize the message — the caller
 * chose this code/status/message deliberately — but it DOES inject request_id, which the hand-rolled
 * `ctx.json({ error, code })` early-returns in the webhook + mcp-customer-reads routes were omitting.
 */
export function clientError(ctx: Context, status: number, code: ApiErrorCode, message: string): Response {
  const requestId = (ctx.get('request_id') as string) || ctx.req.header('cf-ray') || '';
  ctx.status(status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503);
  return ctx.json({ error: message, code, request_id: requestId } satisfies ApiError);
}
