// src/workers/middleware/rate-limit.ts
//
// R51-θ-1 · Cloudflare Workers rate-limit middleware (Hono-compatible).
//
// Authority: federated-waterfall plan §"PHASE 6 / Wave θ" + Cloudflare
// Workers Rate Limiting API.
//
// What this middleware does
// -------------------------
// 1. Per-IP fallback: 100 req/min (suitable for unauthenticated hits)
// 2. Per-user authed: 1000 req/min (50× the IP bucket; assumes real users
//    burst on workspace navigation + recommendations refresh)
// 3. Per-tenant aggregate: 5000 req/min (catches a single tenant exhausting
//    the worker even if individual users stay under their per-user bucket)
// 4. Route-class override: high-cost routes (POST /admin/detector-tick,
//    POST /api/v1/events bulk imports) get stricter buckets via the
//    routeBucket option.
//
// Implementation strategy
// -----------------------
// PRODUCTION: uses Cloudflare's native `RATE_LIMITER` binding (defined in
// wrangler.toml). The binding is a Durable-Object-backed token bucket
// resolved by namespace + key. Operator wires the binding in the Cloudflare
// dashboard (separate buckets for ip, user, tenant, admin).
//
// LOCAL DEV / TESTS: when env.RATE_LIMITER is absent, falls back to an
// in-process Map-based token bucket. This is per-worker-isolate (not
// shared across regions) so it's only useful for unit tests.
//
// Hono middleware contract
// ------------------------
// Returns a `MiddlewareHandler` that calls await next() on allow, OR
// returns a 429 response on deny. Response includes:
//   - Retry-After header (seconds until bucket refills)
//   - X-RateLimit-Remaining + X-RateLimit-Limit headers (observability)
//   - body: { error, code: 'RATE_LIMIT_EXCEEDED', request_id, ...details }
//
// Wave θ ships the MIDDLEWARE FACTORY. Wave ι (or operator step) wires
// `app.use('/api/v1/*', rateLimit())` into src/workers/index.ts.

import type { Context, MiddlewareHandler } from 'hono';
import { envFlagTrue } from '../lib/env-flag';

// ---- Cloudflare native binding shape (per Workers docs) ----
//
// When the binding is configured in wrangler.toml:
//
//   [[unsafe.bindings]]
//   name = "RATE_LIMITER_IP"
//   type = "ratelimit"
//   namespace_id = "1001"
//   simple = { limit = 100, period = 60 }
//
// the binding exposes `.limit({ key: string })` returning `{ success: boolean }`.
interface CloudflareRateLimiterBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

// Per-bucket config (when falling back to in-memory).
interface BucketConfig {
  readonly limit: number;
  readonly periodSeconds: number;
  readonly bindingName?: string;
}

// Top-level config — accepted by rateLimit().
export interface RateLimitConfig {
  readonly ip?: BucketConfig;
  readonly user?: BucketConfig;
  readonly tenant?: BucketConfig;
  readonly routeBucket?: BucketConfig;
  /** Override: skip rate-limit entirely for these route paths (suffix match). */
  readonly skipRoutes?: readonly string[];
  /** Env access; defaults to ctx.env. */
  readonly getEnv?: (ctx: Context) => Record<string, unknown>;
}

const DEFAULT_CONFIG: Required<Omit<RateLimitConfig, 'skipRoutes' | 'getEnv' | 'routeBucket'>> & { skipRoutes: readonly string[]; routeBucket?: BucketConfig } = {
  ip:     { limit: 100,  periodSeconds: 60, bindingName: 'RATE_LIMITER_IP' },
  user:   { limit: 1000, periodSeconds: 60, bindingName: 'RATE_LIMITER_USER' },
  tenant: { limit: 5000, periodSeconds: 60, bindingName: 'RATE_LIMITER_TENANT' },
  skipRoutes: ['/api/v1/health'],
};

// In-memory fallback token bucket. Per-isolate; not shared. For local dev only.
const fallbackBuckets = new Map<string, { tokens: number; refillAt: number }>();

function checkFallbackBucket(key: string, bucket: BucketConfig): boolean {
  const now = Date.now();
  const entry = fallbackBuckets.get(key);
  if (!entry || now > entry.refillAt) {
    fallbackBuckets.set(key, { tokens: bucket.limit - 1, refillAt: now + bucket.periodSeconds * 1000 });
    return true;
  }
  if (entry.tokens > 0) {
    entry.tokens -= 1;
    return true;
  }
  return false;
}

async function checkBucket(
  ctx: Context,
  bucket: BucketConfig,
  key: string,
  getEnv: (ctx: Context) => Record<string, unknown>,
): Promise<{ allowed: boolean; binding: 'cloudflare' | 'fallback' }> {
  const env = getEnv(ctx);
  const binding =
    bucket.bindingName && env[bucket.bindingName] && typeof (env[bucket.bindingName] as any).limit === 'function'
      ? (env[bucket.bindingName] as CloudflareRateLimiterBinding)
      : null;

  if (binding) {
    const result = await binding.limit({ key });
    return { allowed: result.success, binding: 'cloudflare' };
  }
  // Fallback path (local dev / tests).
  const allowed = checkFallbackBucket(`${bucket.bindingName ?? 'anon'}:${key}`, bucket);
  return { allowed, binding: 'fallback' };
}

/**
 * Resolve the IP from the request. Cloudflare sets `cf-connecting-ip`;
 * fallback to the first `x-forwarded-for` hop, then 'unknown'.
 */
function resolveIp(ctx: Context): string {
  const cfIp = ctx.req.header('cf-connecting-ip');
  if (cfIp) return cfIp;
  const xff = ctx.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return 'unknown';
}

/**
 * Resolve the authed user_id from the auth context (set by clerkAuth
 * middleware). Returns null when the request is unauthenticated (caller
 * should still apply the IP bucket).
 */
function resolveUserId(ctx: Context): string | null {
  const auth = ctx.get('auth') as { user_id?: string } | undefined;
  return auth?.user_id ?? null;
}

/**
 * Resolve tenant_id. In production, Workers receive tenant context from
 * the Clerk JWT's `org_id` claim (set in workspace_id via clerkAuth).
 * Bridge by reading the workspace_id from the auth context.
 */
function resolveTenantId(ctx: Context): string | null {
  const auth = ctx.get('auth') as { workspace_id?: string } | undefined;
  return auth?.workspace_id ?? null;
}

/**
 * Hono middleware factory. Returns a middleware handler.
 *
 * Usage:
 *   app.use('/api/v1/*', rateLimit());
 *   app.use('/api/v1/admin/*', rateLimit({ routeBucket: { limit: 10, periodSeconds: 60, bindingName: 'RATE_LIMITER_ADMIN' } }));
 *
 * @param userConfig optional override of bucket defaults
 */
export function rateLimit(userConfig: RateLimitConfig = {}): MiddlewareHandler {
  const config: typeof DEFAULT_CONFIG & { routeBucket?: BucketConfig } = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    ip: { ...DEFAULT_CONFIG.ip, ...(userConfig.ip ?? {}) },
    user: { ...DEFAULT_CONFIG.user, ...(userConfig.user ?? {}) },
    tenant: { ...DEFAULT_CONFIG.tenant, ...(userConfig.tenant ?? {}) },
    skipRoutes: userConfig.skipRoutes ?? DEFAULT_CONFIG.skipRoutes,
    routeBucket: userConfig.routeBucket,
  };
  const getEnv = userConfig.getEnv ?? ((ctx) => ctx.env as Record<string, unknown>);

  return async (ctx, next) => {
    const path = ctx.req.path;

    // Skip explicit allow-list paths (e.g. /api/v1/health).
    for (const skip of config.skipRoutes) {
      if (path === skip || path.endsWith(skip)) {
        return next();
      }
    }

    const ip = resolveIp(ctx);
    const userId = resolveUserId(ctx);
    const tenantId = resolveTenantId(ctx);

    // Always check the IP bucket (covers unauthed paths).
    const ipResult = await checkBucket(ctx, config.ip, `ip:${ip}`, getEnv);
    if (!ipResult.allowed) {
      return rateLimitResponse(ctx, 'ip', config.ip);
    }

    // If authed, also check the user bucket.
    if (userId) {
      const userResult = await checkBucket(ctx, config.user, `user:${userId}`, getEnv);
      if (!userResult.allowed) {
        return rateLimitResponse(ctx, 'user', config.user);
      }
    }

    // Tenant aggregate bucket (catches single-tenant exhaustion).
    if (tenantId) {
      const tenantResult = await checkBucket(ctx, config.tenant, `tenant:${tenantId}`, getEnv);
      if (!tenantResult.allowed) {
        return rateLimitResponse(ctx, 'tenant', config.tenant);
      }
    }

    // Optional per-route bucket (stricter cap on high-cost endpoints).
    if (config.routeBucket) {
      // Key includes the authenticated subject (user_id) when available so
      // one user's bursts don't deny another user on the same shared route.
      const routeKey = userId ? `route:${path}:${userId}` : `route:${path}:ip:${ip}`;
      const routeResult = await checkBucket(ctx, config.routeBucket, routeKey, getEnv);
      if (!routeResult.allowed) {
        return rateLimitResponse(ctx, 'route', config.routeBucket);
      }
    }

    return next();
  };
}

function rateLimitResponse(ctx: Context, bucket: 'ip' | 'user' | 'tenant' | 'route', cfg: BucketConfig) {
  const requestId = (ctx.get('request_id') as string) || '';
  ctx.status(429);
  ctx.header('Retry-After', String(cfg.periodSeconds));
  ctx.header('X-RateLimit-Limit', String(cfg.limit));
  ctx.header('X-RateLimit-Remaining', '0');
  ctx.header('X-RateLimit-Bucket', bucket);
  return ctx.json({
    error: `Rate limit exceeded on ${bucket} bucket (${cfg.limit}/${cfg.periodSeconds}s)`,
    code: 'RATE_LIMIT_EXCEEDED',
    request_id: requestId,
    bucket,
    retry_after_seconds: cfg.periodSeconds,
  });
}

// Test-only helper: clear the in-memory fallback buckets between tests so
// counters don't bleed across cases.
export function __resetFallbackBuckets(): void {
  fallbackBuckets.clear();
}

/**
 * Safety floor (SF-2, 260711): wrap rateLimit() so it runs ONLY when a runtime flag is true.
 * Default-OFF ⇒ the guarded endpoint is byte-identical (straight to next()). Lets the operator flip a
 * per-user cap on the LLM-cost endpoints (customer-chat, readiness) once the durable RATE_LIMITER_*
 * binding is provisioned — until then the flip still applies the best-effort in-isolate fallback cap.
 * envFlagTrue is quote-tolerant (matches every other safety flag in the worker).
 */
export function rateLimitWhenFlag(flagName: string, userConfig: RateLimitConfig = {}): MiddlewareHandler {
  const mw = rateLimit(userConfig);
  return async (ctx, next) => {
    const flag = (ctx.env as Record<string, unknown>)[flagName];
    if (envFlagTrue(typeof flag === 'string' ? flag : undefined)) return mw(ctx, next);
    return next();
  };
}
