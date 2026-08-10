// oauth-as.ts · Stage-2 second half (260806, operator-approved plan) · the PKCE authorization
// server that turns manual token paste into one-click host sign-in.
//
// OAUTH IS AN ONBOARDING LAYER OVER THE EXISTING PRINCIPAL MODEL — the access token minted at
// /oauth/token IS an ordinary `xlk_*` customer connector token (customer_api_tokens row): same
// 90-day expiry, same Settings kill-switch, same UGEC packet fence, same issuance-derived
// entitlement (report-class allowed, decide-class denied). No parallel authz system exists.
//
// Statelessness: clients and codes are self-carried and integrity-protected (lib/oauth-as-crypto);
// the ONLY storage touch is the single-use claim on redemption (idempotency_keys UNIQUE row).
// Everything 503-fails-closed when OAUTH_SIGNING_KEY is unset.
//
// Mounted at the ORIGIN ROOT (not /api/v1) — RFC 8414/7591 paths are origin-anchored, and root
// routes stay outside the API contract (222 tuples unchanged, no frontend pin churn).

import { Hono } from 'hono';
import { clerkAuth, type AuthEnv, type AuthVariables } from '../middleware/auth';
import { authorizeGovernedWrite } from '../lib/spine-authority';
import { neonClient } from '../db/client';
import { createCustomerTokenRow } from '../dal/customer-token-store';
import { envFlagTrue } from '../lib/env-flag';
import {
  CUSTOMER_CONNECTOR_SCOPES,
  resolveRequestedCustomerScopes,
} from '../lib/customer-connector-scopes';
import {
  AUTH_CODE_TTL_SECONDS,
  mintClientId,
  verifyClientId,
  sealGrant,
  openGrant,
  s256Challenge,
  sha256HexOf,
  redirectUriRegistrable,
  redirectUriMatches,
} from '../lib/oauth-as-crypto';

export const OAUTH_ISSUER = 'https://api.xlooop.com';
export const OAUTH_CONSENT_PAGE = 'https://app.xlooop.com/oauth/consent';

export interface OAuthAsEnv extends AuthEnv {
  DATABASE_URL: string;
  OAUTH_SIGNING_KEY?: string;
  CUSTOMER_OPERATIONAL_TOKENS_ENABLED?: string;
}
export interface OAuthAsVariables extends AuthVariables {
  sql?: ReturnType<typeof neonClient>; // injectable seam (tests) — same pattern as mcp-customer-reads
}

export const oauthAsRoute = new Hono<{ Bindings: OAuthAsEnv; Variables: OAuthAsVariables }>();

function sqlFor(ctx: { get: (k: 'sql') => unknown; env: { DATABASE_URL: string } }) {
  return (ctx.get('sql') as ReturnType<typeof neonClient> | undefined) ?? neonClient(ctx.env.DATABASE_URL);
}
function oauthError(ctx: { status: (s: 400 | 403 | 503) => void; json: (b: unknown) => Response; req?: { header: (name: string) => string | undefined } }, status: 400 | 403 | 503, error: string, description: string): Response {
  if (error === 'invalid_grant' || error === 'invalid_client') {
    // AS hardening (260806): structured, greppable denial telemetry (the
    // cockpit_chat_unknown_mode_coerced pattern) — repeated invalid_grant from one origin is the
    // brute-force signature the rate limiter alone cannot narrate.
    console.warn(JSON.stringify({
      event: 'oauth_as_denied',
      error,
      description,
      ip: ctx.req?.header('cf-connecting-ip') ?? 'unknown',
    }));
  }
  ctx.status(status);
  return ctx.json({ error, error_description: description });
}
function signingKey(ctx: { env: { OAUTH_SIGNING_KEY?: string } }): string | null {
  const k = (ctx.env.OAUTH_SIGNING_KEY || '').trim();
  return k.length >= 32 ? k : null; // fail closed on absent OR weak key
}
function slugifyWorkspace(id: string): string {
  return (id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ws');
}
function mintRawToken(role: 'viewer' | 'operator'): string {
  const hex = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  return `xlk_${role === 'operator' ? 'op' : 'ro'}_${hex}`;
}

// ── RFC 8414 · authorization-server metadata ─────────────────────────────────────────────────────
oauthAsRoute.get('/.well-known/oauth-authorization-server', (ctx) => {
  ctx.header('Cache-Control', 'public, max-age=3600');
  return ctx.json({
    issuer: OAUTH_ISSUER,
    authorization_endpoint: `${OAUTH_ISSUER}/oauth/authorize`,
    token_endpoint: `${OAUTH_ISSUER}/oauth/token`,
    registration_endpoint: `${OAUTH_ISSUER}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'], // no refresh grant — tokens live 90 days, hosts re-auth after
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], // public clients (PKCE is the proof)
    scopes_supported: [...CUSTOMER_CONNECTOR_SCOPES, 'viewer', 'operator'],
    service_documentation: 'https://app.xlooop.com/settings',
  });
});

// ── RFC 7591 · dynamic client registration (stateless) ───────────────────────────────────────────
oauthAsRoute.post('/oauth/register', async (ctx) => {
  const key = signingKey(ctx);
  if (!key) return oauthError(ctx, 503, 'temporarily_unavailable', 'authorization server is not configured');
  const body = await ctx.req.json().catch(() => null) as { redirect_uris?: unknown; client_name?: unknown } | null;
  const uris = Array.isArray(body?.redirect_uris) ? body!.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (uris.length === 0 || uris.length > 8) {
    return oauthError(ctx, 400, 'invalid_redirect_uri', 'redirect_uris must contain 1-8 entries');
  }
  for (const u of uris) {
    if (!redirectUriRegistrable(u)) {
      return oauthError(ctx, 400, 'invalid_redirect_uri', `not registrable (https, or http on loopback, no credentials/fragment): ${u.slice(0, 120)}`);
    }
  }
  const client_id = await mintClientId(uris, key, Date.now());
  ctx.status(201);
  return ctx.json({
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    client_name: typeof body?.client_name === 'string' ? body.client_name.slice(0, 80) : undefined,
  });
});

// ── RFC 6749 §4.1.1 · authorization endpoint ─────────────────────────────────────────────────────
// SECURITY INVARIANT: a request whose client_id or redirect_uri fails validation gets a 400 PAGE,
// NEVER a redirect — redirecting an unvalidated URI is an open redirect + code-leak vector.
oauthAsRoute.get('/oauth/authorize', async (ctx) => {
  const key = signingKey(ctx);
  if (!key) return oauthError(ctx, 503, 'temporarily_unavailable', 'authorization server is not configured');
  const q = new URL(ctx.req.url).searchParams;
  const clientId = q.get('client_id') || '';
  const redirectUri = q.get('redirect_uri') || '';
  const client = clientId ? await verifyClientId(clientId, key) : null;
  if (!client) return oauthError(ctx, 400, 'invalid_client', 'unknown or unverifiable client_id');
  if (!redirectUri || !redirectUriMatches(redirectUri, client.ru)) {
    return oauthError(ctx, 400, 'invalid_request', 'redirect_uri is not registered for this client');
  }
  // From here the redirect target is TRUSTED; per-RFC errors may bounce to it.
  const bounce = (error: string, description: string) => {
    const to = new URL(redirectUri);
    to.searchParams.set('error', error);
    to.searchParams.set('error_description', description);
    const state = q.get('state');
    if (state) to.searchParams.set('state', state);
    return ctx.redirect(to.toString(), 302);
  };
  if (q.get('response_type') !== 'code') return bounce('unsupported_response_type', 'only response_type=code is supported');
  if ((q.get('code_challenge_method') || '') !== 'S256') return bounce('invalid_request', 'PKCE S256 is required');
  const challenge = q.get('code_challenge') || '';
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return bounce('invalid_request', 'malformed code_challenge');

  const consent = new URL(OAUTH_CONSENT_PAGE);
  for (const k of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope'] as const) {
    const v = q.get(k);
    if (v) consent.searchParams.set(k, v);
  }
  return ctx.redirect(consent.toString(), 302);
});

// ── the consent decision · Clerk-authed, same governed gate as manual token minting ──────────────
oauthAsRoute.use('/oauth/consent', clerkAuth());
oauthAsRoute.post('/oauth/consent', async (ctx) => {
  const key = signingKey(ctx);
  if (!key) return oauthError(ctx, 503, 'temporarily_unavailable', 'authorization server is not configured');
  const auth = ctx.get('auth');
  if (auth.auth_method !== 'clerk_jwt') {
    return oauthError(ctx, 403, 'access_denied', 'consent requires a human session');
  }
  if (!(await authorizeGovernedWrite(ctx as never, 'token:create')).allowed) {
    return oauthError(ctx, 403, 'access_denied', 'only workspace owners or operators may authorize a connector');
  }
  const body = await ctx.req.json().catch(() => null) as Record<string, unknown> | null;
  const clientId = typeof body?.client_id === 'string' ? body.client_id : '';
  const redirectUri = typeof body?.redirect_uri === 'string' ? body.redirect_uri : '';
  const challenge = typeof body?.code_challenge === 'string' ? body.code_challenge : '';
  const state = typeof body?.state === 'string' ? body.state : '';
  const scope = typeof body?.scope === 'string' ? body.scope : '';
  const client = clientId ? await verifyClientId(clientId, key) : null;
  if (!client) return oauthError(ctx, 400, 'invalid_client', 'unknown or unverifiable client_id');
  if (!redirectUri || !redirectUriMatches(redirectUri, client.ru)) {
    return oauthError(ctx, 400, 'invalid_request', 'redirect_uri is not registered for this client');
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return oauthError(ctx, 400, 'invalid_request', 'malformed code_challenge');

  const resolved = resolveRequestedCustomerScopes(
    scope,
    envFlagTrue(ctx.env.CUSTOMER_OPERATIONAL_TOKENS_ENABLED),
  );
  if (!resolved.ok) return oauthError(ctx, 400, 'invalid_scope', resolved.reason);

  const code = await sealGrant({
    cid_sha: await sha256HexOf(clientId),
    redirect_uri: redirectUri,
    cc: challenge,
    workspace_id: auth.workspace_id,
    user_id: auth.user_id,
    role: resolved.role,
    scopes: resolved.scopes,
    exp: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS,
    n: crypto.randomUUID(),
  }, key);

  const to = new URL(redirectUri);
  to.searchParams.set('code', code);
  if (state) to.searchParams.set('state', state);
  return ctx.json({
    redirect_to: to.toString(),
    granted_role: resolved.role,
    granted_scopes: resolved.scopes,
  });
});

// ── RFC 6749 §4.1.3 / RFC 7636 · token endpoint ──────────────────────────────────────────────────
oauthAsRoute.post('/oauth/token', async (ctx) => {
  const key = signingKey(ctx);
  if (!key) return oauthError(ctx, 503, 'temporarily_unavailable', 'authorization server is not configured');
  const contentType = ctx.req.header('content-type') || '';
  let p: Record<string, string> = {};
  if (contentType.includes('application/json')) {
    const j = await ctx.req.json().catch(() => null) as Record<string, unknown> | null;
    if (j) for (const [k, v] of Object.entries(j)) { if (typeof v === 'string') p[k] = v; }
  } else {
    const form = await ctx.req.formData().catch(() => null);
    if (form) {
      form.forEach((value, field) => {
        if (typeof value === 'string') p[field] = value;
      });
    }
  }
  if (p.grant_type !== 'authorization_code') {
    return oauthError(ctx, 400, 'unsupported_grant_type', 'only authorization_code is supported');
  }
  const grant = p.code ? await openGrant(p.code, key, Date.now()) : null;
  if (!grant) return oauthError(ctx, 400, 'invalid_grant', 'code is invalid or expired');
  if (!p.client_id || (await sha256HexOf(p.client_id)) !== grant.cid_sha) {
    return oauthError(ctx, 400, 'invalid_grant', 'code was not issued to this client');
  }
  if (!p.redirect_uri || p.redirect_uri !== grant.redirect_uri) {
    return oauthError(ctx, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
  }
  if (!p.code_verifier || (await s256Challenge(p.code_verifier)) !== grant.cc) {
    return oauthError(ctx, 400, 'invalid_grant', 'PKCE verification failed');
  }

  const sql = sqlFor(ctx);
  // SINGLE-USE: claim the code before minting. UNIQUE(workspace_id, idempotency_key) makes a
  // replayed code insert zero rows — the reservation IS the replay detector (mig 065).
  const codeSha = await sha256HexOf(p.code);
  const claimed = (await sql/*sql*/`
    INSERT INTO idempotency_keys (workspace_id, idempotency_key, route, response_status)
    VALUES (${grant.workspace_id}, ${'oauth_code:' + codeSha}, ${'oauth/token'}, ${200})
    ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
    RETURNING id
  `) as Array<{ id: unknown }>;
  if (claimed.length === 0) {
    return oauthError(ctx, 400, 'invalid_grant', 'code has already been redeemed');
  }

  const memberships = (await sql/*sql*/`
    SELECT activated_at
    FROM workspace_members
    WHERE workspace_id = ${grant.workspace_id}
      AND user_id = ${grant.user_id}
      AND status = 'active'
      AND removed_at IS NULL
    LIMIT 1
  `) as Array<{ activated_at: string | null }>;
  const issuerMembershipActivatedAt = memberships[0]?.activated_at ?? null;
  if (!issuerMembershipActivatedAt) {
    return oauthError(ctx, 403, 'access_denied', 'the authorizing workspace membership is no longer active');
  }

  const raw = mintRawToken(grant.role);
  const clientHost = (() => { try { return new URL(grant.redirect_uri).hostname; } catch { return 'client'; } })();
  const created = await createCustomerTokenRow(sql, {
    workspace_id: grant.workspace_id,
    token_sha256: await sha256HexOf(raw),
    role: grant.role,
    label: `OAuth connector · ${clientHost}`.slice(0, 80),
    packet_prefix: `pkt-${slugifyWorkspace(grant.workspace_id)}-`,
    scopes: grant.scopes,
    authority_mode: 'delegated_user',
    issuer_membership_activated_at: issuerMembershipActivatedAt,
    created_by: grant.user_id,
    expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
  });

  return ctx.json({
    access_token: raw,
    token_type: 'bearer',
    expires_in: Math.max(0, Math.floor((Date.parse(created.expires_at) - Date.now()) / 1000)),
    scope: grant.scopes.join(' '),
  });
});
