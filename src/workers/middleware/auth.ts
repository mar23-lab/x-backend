// auth.ts · Clerk JWT validation middleware for Hono on Cloudflare Workers
//
// Authority: AUTH_TENANCY_MODEL.md §JWT validation flow
//
// Behavior:
//   1. Reads Authorization: Bearer <jwt> header
//   2. Verifies JWT signature against Clerk's JWKS (cached in-memory, TTL 5 min)
//   3. Extracts { sub, org_id, org_role } claims
//   4. Maps org_role → WorkspaceRole via clerkRoleToWorkspaceRole()
//   5. Sets ctx.set('auth', AuthContext) for downstream handlers
//
// Behavior on failure:
//   - Missing/invalid token → 401 UNAUTHORIZED
//   - Missing org_id (personal session) → 403 FORBIDDEN
//   - Expired token → 401 UNAUTHORIZED

import { Context, MiddlewareHandler } from 'hono';
import { envFlagTrue } from '../lib/env-flag';
import { verifyToken } from '@clerk/backend';
import { clerkRoleToWorkspaceRole } from '../dal/visibility';
import type { AuthContext } from '../dal/types';
import { neonClient } from '../db/client';
import { getCustomerTokenByHashRow, touchCustomerTokenRow } from '../dal/customer-token-store';

export interface AuthEnv {
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_JWKS_URL?: string;
  CLERK_JWKS_CACHE_TTL_SECONDS?: string;
  XLOOOP_CANARY_API_TOKEN_SHA256?: string;
  XLOOOP_CANARY_LIFECYCLE_TOKEN_SHA256?: string;
  XLOOOP_CANARY_WORKSPACE_ID?: string;
  // Customer connector tokens (migration 037). DATABASE_URL is the existing global Neon binding;
  // CUSTOMER_API_TOKENS_ENABLED gates the whole feature OFF by default (inert on merge).
  DATABASE_URL?: string;
  // Migration 043 RLS cutover · the non-owner `xlooop_app` DSN. Tenant read routes bind their sql to
  // this (falling back to DATABASE_URL) so per-request RLS context applies — a cross-route env binding.
  XLOOOP_RLS_APP_DATABASE_URL?: string;
  CUSTOMER_API_TOKENS_ENABLED?: string;
}

export type AuthVariables = {
  auth: AuthContext;
  request_id: string;
};

export interface ClerkAuthOptions {
  /**
   * If false, missing org_id is allowed (workspace_id will be set to '' as placeholder).
   * Use for admin routes — admins don't need to be members of any Clerk org.
   * Default: true.
   */
  requireOrg?: boolean;
  /**
   * Allow the scoped validation service-principal token on this route group.
   * The read canary is role=viewer. The lifecycle canary is role=operator, but
   * downstream API/MCP routes must additionally fence it to pkt-canary-*,
   * metadata-only evidence, canary metrics, and non-customer lifecycle writes.
   */
  allowCanary?: boolean;
  /**
   * Allow customer connector tokens (service_principal === 'customer_token') on this route group.
   * Enabled ONLY on the customer-safe MCP surface (operationalRoutes) so a customer token can
   * never reach the full protected route set. Still inert unless CUSTOMER_API_TOKENS_ENABLED=true.
   */
  allowCustomerToken?: boolean;
}

/**
 * Hono middleware that requires a valid Clerk JWT.
 * Sets ctx.var.auth on success.
 */
export function clerkAuth(opts: ClerkAuthOptions = {}): MiddlewareHandler<{
  Bindings: AuthEnv;
  Variables: AuthVariables;
}> {
  const requireOrg = opts.requireOrg !== false;
  return async (ctx, next) => {
    const requestId =
      ctx.req.header('cf-ray') ||
      ctx.req.header('x-request-id') ||
      cryptoRandomId();
    ctx.set('request_id', requestId);

    const authHeader = ctx.req.header('authorization') || ctx.req.header('Authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return jsonError(ctx, 401, 'UNAUTHORIZED', 'Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return jsonError(ctx, 401, 'UNAUTHORIZED', 'Bearer token is empty');
    }

    const canary = await canaryAuth(ctx, token, opts);
    if (canary === 'matched') {
      await next();
      return;
    }
    if (canary === 'forbidden') {
      return jsonError(ctx, 403, 'FORBIDDEN', 'canary service-principal is not allowed on this route');
    }

    const customer = await customerTokenAuth(ctx, token, opts);
    if (customer === 'matched') {
      await next();
      return;
    }
    if (customer === 'expired') {
      return jsonError(ctx, 401, 'UNAUTHORIZED', 'customer connector token has expired');
    }

    try {
      const payload = await verifyToken(token, {
        secretKey: ctx.env.CLERK_SECRET_KEY,
      });

      const userId = (payload as any).sub as string | undefined;
      const orgId = (payload as any).org_id as string | undefined;
      const orgRole = (payload as any).org_role as string | undefined;
      const exp = Number((payload as any).exp || 0);

      if (!userId) {
        return jsonError(ctx, 401, 'UNAUTHORIZED', 'JWT missing sub claim');
      }
      if (requireOrg && !orgId) {
        return jsonError(
          ctx,
          403,
          'FORBIDDEN',
          'JWT missing org_id — personal sessions cannot access workspace data'
        );
      }

      const role = clerkRoleToWorkspaceRole(orgRole);

      // When requireOrg=false (admin routes), workspace_id is set to '' as placeholder.
      // Admin route handlers must not consume workspace_id; they operate on user_id only.
      const auth: AuthContext = {
        user_id: userId,
        workspace_id: orgId ?? '',
        role,
        auth_method: 'clerk_jwt',
        client_id: 'clerk_user',
        token_expires_at: exp ? new Date(exp * 1000).toISOString() : null,
        // Track B · verified email from the JWT (when the Clerk JWT template
        // includes it) — the investor session endpoint prefers this trusted
        // source over the self-typed NDA email. Additive; existing routes ignore it.
        email: (payload as any).email as string | undefined,
      };
      ctx.set('auth', auth);
      await next();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Token verification failed';
      return jsonError(ctx, 401, 'UNAUTHORIZED', `Token verification failed: ${msg}`);
    }
  };
}

// ---- helpers (kept internal so middleware stays self-contained) ----

function jsonError(
  ctx: Context,
  status: number,
  code: string,
  message: string
): Response {
  const requestId = (ctx.get('request_id') as string) || '';
  ctx.status(status as 401 | 403 | 500);
  return ctx.json({
    error: message,
    code,
    request_id: requestId,
  });
}

function cryptoRandomId(): string {
  // Workers provides globalThis.crypto.randomUUID()
  try {
    return (globalThis.crypto as any).randomUUID();
  } catch {
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

type CanaryAuthResult = 'matched' | 'forbidden' | 'miss';

async function canaryAuth(
  ctx: Context<{ Bindings: AuthEnv; Variables: AuthVariables }>,
  token: string,
  opts: ClerkAuthOptions,
): Promise<CanaryAuthResult> {
  const readHash = normalizeSha256Hex(ctx.env.XLOOOP_CANARY_API_TOKEN_SHA256);
  const lifecycleHash = normalizeSha256Hex(ctx.env.XLOOOP_CANARY_LIFECYCLE_TOKEN_SHA256);
  const workspaceId = ctx.env.XLOOOP_CANARY_WORKSPACE_ID?.trim();
  if ((!readHash && !lifecycleHash) || !workspaceId) return 'miss';

  const tokenHash = await sha256Hex(token);
  const isReadMatch = readHash ? timingSafeHexEqual(tokenHash, readHash) : false;
  const isLifecycleMatch = lifecycleHash ? timingSafeHexEqual(tokenHash, lifecycleHash) : false;
  if (!isReadMatch && !isLifecycleMatch) return 'miss';
  if (!opts.allowCanary) return 'forbidden';

  ctx.set('auth', {
    user_id: isLifecycleMatch ? 'svc_xlooop_canary_lifecycle' : 'svc_xlooop_canary',
    workspace_id: workspaceId,
    role: isLifecycleMatch ? 'operator' : 'viewer',
    auth_method: 'service_principal',
    client_id: isLifecycleMatch ? 'xlooop-canary-lifecycle' : 'xlooop-canary-read',
    token_expires_at: null,
    email: isLifecycleMatch
      ? 'svc_xlooop_canary_lifecycle@xlooop.local'
      : 'svc_xlooop_canary@xlooop.local',
    service_principal: isLifecycleMatch ? 'canary_lifecycle' : 'canary_read',
  });
  return 'matched';
}

/**
 * Customer connector token auth — the DB-backed generalization of canaryAuth.
 *
 * A customer mints an opaque, revocable, workspace-scoped token (see developer-access.ts +
 * customer-token-store). Here we resolve it to an AuthContext. Inert unless the route opts in
 * (allowCustomerToken) AND the feature flag is on — so merging this changes nothing in prod until
 * the operator enables it. Revoked/expired tokens fail closed: getCustomerTokenByHashRow only
 * returns live rows, so a revoked token returns 'miss' → falls through to Clerk → 401
 * (satisfies the "revoking the token must make access fail" requirement).
 */
async function customerTokenAuth(
  ctx: Context<{ Bindings: AuthEnv; Variables: AuthVariables }>,
  token: string,
  opts: ClerkAuthOptions,
): Promise<'matched' | 'expired' | 'miss'> {
  if (!opts.allowCustomerToken) return 'miss';
  if (!envFlagTrue(ctx.env.CUSTOMER_API_TOKENS_ENABLED)) return 'miss';
  if (token.includes('.')) return 'miss'; // JWTs contain dots; customer tokens never do
  const dbUrl = ctx.env.DATABASE_URL;
  if (!dbUrl) return 'miss';

  let row;
  let sql;
  try {
    sql = neonClient(dbUrl);
    const tokenHash = await sha256Hex(token);
    row = await getCustomerTokenByHashRow(sql, tokenHash);
  } catch {
    return 'miss'; // never let a token-lookup error masquerade as a forbidden/expired result
  }
  if (!row) return 'miss';
  if (Date.parse(row.expires_at) <= Date.now()) return 'expired';

  ctx.set('auth', {
    user_id: `svc_customer_${row.id}`,
    workspace_id: row.workspace_id,
    role: row.role,
    auth_method: 'service_principal',
    service_principal: 'customer_token',
    client_id: `customer-${row.role}`,
    token_expires_at: row.expires_at,
    packet_prefix: row.packet_prefix,
  });

  try {
    ctx.executionCtx.waitUntil(touchCustomerTokenRow(sql, row.id).catch(() => {}));
  } catch {
    /* no execution context (e.g. unit test) — heartbeat is best-effort */
  }
  return 'matched';
}

function normalizeSha256Hex(value?: string): string {
  const clean = (value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(clean) ? clean : '';
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  let diff = 0;
  for (let i = 0; i < 64; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
