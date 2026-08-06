// request-guards.ts - request-shape guards for the API worker.
// X-SCP P0.2 - ingress plane (security control-plane plan Part II).
//
// Cheap DoS / abuse guards on mutating requests: a 10MB body-size cap (rejected
// from Content-Length before the body is read) and Content-Type enforcement for
// JSON mutations. JSON *and* multipart/form-data are accepted — multipart is a
// legitimate upload body (POST /api/v1/documents file uploads, which the documents
// route then guards with its own file-type allow-list + 5MB cap). Without this,
// the global guard rejected the upload with 415 before the route ran (260630 fix).
// Webhook routes (signed / non-JSON bodies) are path-exempted so integrations are
// not broken. Returns the standard ApiError envelope.

import { MiddlewareHandler } from 'hono';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CONTENT_TYPE_EXEMPT = ['webhook'];
// RFC 6749 §4.1.3 REQUIRES the OAuth token endpoint to accept
// application/x-www-form-urlencoded — it is what every standard OAuth client (incl. Claude
// Code's MCP OAuth flow) sends. Scoped to this exact path: the endpoint is public, cookie-less,
// and PKCE-bound, so the CSRF rationale for excluding form posts from the JSON API plane does
// not apply. Everywhere else form-urlencoded stays 415 (260806 live-probe fix).
const FORM_URLENCODED_OK_PATHS = new Set(['/oauth/token']);

export function requestGuards(): MiddlewareHandler {
  return async (ctx, next) => {
    const method = ctx.req.method.toUpperCase();
    if (MUTATING_METHODS.has(method)) {
      const len = Number(ctx.req.header('content-length') || '0');
      if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
        return ctx.json({ error: 'request body exceeds 10MB limit', code: 'PAYLOAD_TOO_LARGE', request_id: '' }, 413);
      }
      const exempt = CONTENT_TYPE_EXEMPT.some((p) => ctx.req.path.includes(p));
      // SEC-4 (J-W4 260711-I): a chunked/streamed request carries a body but NO Content-Length, so the
      // old `len > 0` precondition skipped BOTH the size cap and this content-type gate for exactly the
      // unbounded case. Enforce content-type when the request HAS a body — either Content-Length > 0 OR
      // Transfer-Encoding present (chunked). A genuinely bodyless request (no CL, no TE, e.g. an admin
      // POST whose action is in the URL) still passes, so we don't 415 legitimate bodyless mutations.
      const hasBody = len > 0 || (ctx.req.header('transfer-encoding') || '').trim().length > 0;
      if (hasBody && !exempt) {
        const contentType = (ctx.req.header('content-type') || '').toLowerCase();
        const okType = contentType.includes('application/json') || contentType.includes('multipart/form-data')
          || (FORM_URLENCODED_OK_PATHS.has(ctx.req.path) && contentType.includes('application/x-www-form-urlencoded'));
        if (!okType) {
          return ctx.json({ error: 'unsupported content-type; expected application/json or multipart/form-data', code: 'UNSUPPORTED_MEDIA_TYPE', request_id: '' }, 415);
        }
      }
    }
    await next();
    return; // explicit return for noImplicitReturns
  };
}
