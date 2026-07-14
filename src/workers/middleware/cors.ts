// cors.ts · CORS middleware locked to *.xlooop.com (per API_CONTRACT_V1.md §CORS policy)
//
// Behavior:
//   - Production: only https://*.xlooop.com origins allowed (no wildcard)
//   - Development: localhost:* added when ENVIRONMENT=development
//   - Preflight cached: 24 hours

import { MiddlewareHandler } from 'hono';

export interface CorsEnv {
  ALLOWED_ORIGIN_PATTERN?: string; // default: https://*.xlooop.com
  ENVIRONMENT?: string;
}

// GET/POST for reads + creates; PUT/PATCH/DELETE for the mutating REST routes (session-mode PATCH,
// members role-change PATCH, model-runtimes PUT/DELETE — Wave B/C). app->api is cross-origin, so a method
// missing here is preflight-blocked by the browser ("Method X is not allowed by Access-Control-Allow-Methods").
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
// X-Xlooop-Workspace-Assert: the org-scoping fix (PR #622) attaches this DIAGNOSTIC header on every
// request once an org is active. app->api is cross-origin, so the header MUST be preflight-allowlisted
// or the browser blocks the actual request — breaking exactly the org-scoped customers the fix unblocks.
const ALLOWED_HEADERS = 'Authorization, Content-Type, X-Request-Id, X-Xlooop-Workspace-Assert, Idempotency-Key';
const MAX_AGE_SECONDS = '86400';

export function corsMiddleware(): MiddlewareHandler<{ Bindings: CorsEnv }> {
  return async (ctx, next) => {
    const origin = ctx.req.header('origin') || '';
    const allowedPattern = ctx.env.ALLOWED_ORIGIN_PATTERN || 'https://*.xlooop.com';
    const isDev = (ctx.env.ENVIRONMENT || '').toLowerCase() === 'development';

    const allowed = originIsAllowed(origin, allowedPattern, isDev);

    // Always handle OPTIONS preflight first
    if (ctx.req.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers': ALLOWED_HEADERS,
        'Access-Control-Max-Age': MAX_AGE_SECONDS,
        Vary: 'Origin',
      };
      if (allowed && origin) headers['Access-Control-Allow-Origin'] = origin;
      return new Response(null, { status: 204, headers });
    }

    await next();

    // Attach CORS headers to all responses (mutate ctx.res)
    if (allowed && origin) {
      ctx.res.headers.set('Access-Control-Allow-Origin', origin);
      ctx.res.headers.set('Vary', 'Origin');
    }
    return; // explicit return for noImplicitReturns
  };
}

/**
 * Pattern matching for allowed origins.
 * Supports a single wildcard like `https://*.xlooop.com`.
 * Dev mode allows `http://localhost:*` and `http://127.0.0.1:*`.
 */
export function originIsAllowed(origin: string, pattern: string, isDev: boolean): boolean {
  if (!origin) return false;

  if (isDev) {
    if (
      origin.startsWith('http://localhost:') ||
      origin === 'http://localhost' ||
      origin.startsWith('http://127.0.0.1:') ||
      origin === 'http://127.0.0.1'
    ) {
      return true;
    }
  }

  // Convert pattern like "https://*.xlooop.com" → regex.
  // NOTE: the first replace escapes regex specials but intentionally NOT `*`,
  // because the second replace converts bare `*` into the subdomain wildcard.
  // Earlier version escaped `*` then replaced `\*`, but `*` was never in the
  // first list, so the second replace found nothing and `*` was left as a
  // regex quantifier (`//*` matched 0+ slashes, not a subdomain).
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+');
  const re = new RegExp(`^${escaped}$`);
  return re.test(origin);
}
