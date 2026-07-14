// clerk-oauth-adapter.ts · R50.3b · 2026-05-28
//
// Authority: R50 plan stage R50.3b · CLERK_OAUTH_PROVIDER_CONFIG.md
//
// Wraps @clerk/backend v1.20.0's `clerkClient.users.getUserOauthAccessToken()`
// with:
//   1. Defensive error mapping into OAuthAdapterError (typed code taxonomy)
//   2. Per-user-per-provider in-memory token cache with TTL respecting
//      Clerk's token expiry semantics (Clerk auto-refreshes most providers
//      but not all; for those it doesn't, our TTL is shorter than typical
//      provider expiry to force re-fetch before downstream API rejection)
//   3. Provider-name mapping (our internal `microsoft_onedrive` → Clerk's
//      bare `microsoft` slug; see OAUTH_PROVIDER_TO_CLERK_SLUG in types.ts)
//
// USED BY:
//   - src/workers/routes/sources.ts (R50.3b · operator-facing REST surface)
//   - src/workers/sources/translators/*.ts (R50.3c · per-provider event emission)
//   - src/workers/cron/source-sync-tick.ts (R50.3d · scheduled sync)
//
// STOP CONDITION (codified in XLOOOP_SYSTEM_DESIGN_v1.md §16 stops):
//   `source_translator_ingests_file_content_beyond_contract` (HARD post-R50.3c)
//   The adapter itself is contract-agnostic; the contract-enforcer in R50.3c
//   reads `user_source_connections.contract` and validates before INSERT.
//
// TESTING:
//   Unit tests will be added in R50.3c alongside the translators (they share
//   the error-mapping surface). Smoke checks added in R50-Tail follow-up
//   confirm the adapter file + exported API.

import { createClerkClient } from '@clerk/backend';
import type {
  OAuthAccessTokenSnapshot,
  OAuthAdapterError,
  OAuthAdapterErrorCode,
  OAuthProvider,
  UserId,
} from './types';
import { OAUTH_PROVIDER_TO_CLERK_SLUG } from './types';

// ---------------------------------------------------------------------------
// Cache · per-instance (Workers isolate scope; resets between cold starts)
// ---------------------------------------------------------------------------

// Default cache TTL · 90% of typical provider token lifetimes. Clerk refreshes
// many providers (e.g. Google, Microsoft) automatically; for providers that
// don't auto-refresh (e.g. GitHub installation tokens for legacy app types),
// our shorter TTL forces re-fetch before downstream API rejection.
//
// Override per call via getAccessToken({ cache_ttl_seconds }) when a caller
// has provider-specific expiry knowledge (e.g. R50.3d cron pulling fresh
// tokens before every sync regardless of TTL).
const DEFAULT_CACHE_TTL_SECONDS = 50 * 60; // 50 minutes

type CacheEntry = { snapshot: OAuthAccessTokenSnapshot; expires_at_ms: number };
const tokenCache = new Map<string, CacheEntry>();

function cacheKey(userId: UserId, provider: OAuthProvider): string {
  return `${userId}::${provider}`;
}

// ---------------------------------------------------------------------------
// Error construction
// ---------------------------------------------------------------------------

function buildError(
  code: OAuthAdapterErrorCode,
  message: string,
  ctx: { provider?: OAuthProvider; user_id?: UserId; clerk_status?: number; clerk_message?: string } = {},
): OAuthAdapterError {
  const err = new Error(message) as OAuthAdapterError;
  err.code = code;
  if (ctx.provider !== undefined) err.provider = ctx.provider;
  if (ctx.user_id !== undefined) err.user_id = ctx.user_id;
  if (ctx.clerk_status !== undefined) err.clerk_status = ctx.clerk_status;
  if (ctx.clerk_message !== undefined) err.clerk_message = ctx.clerk_message;
  return err;
}

// Inspect a thrown error / response from Clerk and map it to our taxonomy.
// Clerk v1 returns errors with shape: { status, clerkTraceId, errors: [{code, message}] }
// or throws a network error; we handle both.
function mapClerkError(
  rawError: unknown,
  provider: OAuthProvider,
  userId: UserId,
): OAuthAdapterError {
  const anyErr = rawError as { status?: number; errors?: Array<{ code?: string; message?: string }>; message?: string };
  const clerkStatus = anyErr?.status;
  const firstErr = anyErr?.errors?.[0];
  const clerkCode = firstErr?.code || '';
  const clerkMsg = firstErr?.message || anyErr?.message || 'unknown clerk error';

  // Clerk specific error codes → adapter taxonomy
  // Per https://clerk.com/docs/errors error code reference (as of v1.20):
  //   "oauth_access_token_retrieval_error" → token absent or revoked
  //   "external_account_not_found"         → user has not connected this provider
  //   "resource_not_found"                 → provider not configured in dashboard
  //   "form_param_format_invalid"          → bad provider slug
  if (clerkStatus === 404 || clerkCode === 'external_account_not_found') {
    return buildError(
      'OAUTH_NOT_CONNECTED',
      `User ${userId} has not connected the ${provider} provider in their Clerk account`,
      { provider, user_id: userId, clerk_status: clerkStatus, clerk_message: clerkMsg },
    );
  }
  if (clerkCode === 'oauth_access_token_retrieval_error' || /revoked/i.test(clerkMsg)) {
    return buildError(
      'OAUTH_REVOKED',
      `OAuth token for ${userId}/${provider} was revoked (by user or by provider)`,
      { provider, user_id: userId, clerk_status: clerkStatus, clerk_message: clerkMsg },
    );
  }
  if (clerkCode === 'resource_not_found' && /provider/i.test(clerkMsg)) {
    return buildError(
      'OAUTH_PROVIDER_NOT_CONFIGURED',
      `Provider ${provider} is not enabled in the Clerk dashboard. Run scripts/verify-r50-3a-empirical-state.mjs --clerk-only to verify.`,
      { provider, user_id: userId, clerk_status: clerkStatus, clerk_message: clerkMsg },
    );
  }
  // Default · generic Clerk API error
  return buildError(
    'OAUTH_CLERK_API_ERROR',
    `Clerk API error fetching ${provider} token for ${userId}: ${clerkMsg}`,
    { provider, user_id: userId, clerk_status: clerkStatus, clerk_message: clerkMsg },
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClerkOAuthAdapterOptions {
  /** Cache TTL in seconds (default 50 min). Set to 0 to disable cache. */
  cache_ttl_seconds?: number;
  /** Force-skip cache and fetch fresh token. */
  force_refresh?: boolean;
}

export interface ClerkOAuthAdapter {
  /** Fetch a fresh (or cached) OAuth access token for (user, provider). */
  getAccessToken(
    userId: UserId,
    provider: OAuthProvider,
    opts?: ClerkOAuthAdapterOptions,
  ): Promise<OAuthAccessTokenSnapshot>;

  /** List ALL OAuth providers the user has connected in Clerk (any provider, not just our 5). */
  listConnectedProviders(userId: UserId): Promise<string[]>;

  /** Manually invalidate the cached token for (user, provider). Used by R50.3d on rate-limit 429s. */
  invalidateCache(userId: UserId, provider: OAuthProvider): void;
}

/**
 * Build a ClerkOAuthAdapter bound to a specific CLERK_SECRET_KEY.
 *
 * Workers usage:
 *   ```ts
 *   const adapter = makeClerkOAuthAdapter(env.CLERK_SECRET_KEY);
 *   const snapshot = await adapter.getAccessToken(userId, 'github');
 *   // snapshot.token is a fresh OAuth bearer token; use it to call GitHub API
 *   ```
 */
export function makeClerkOAuthAdapter(secretKey: string): ClerkOAuthAdapter {
  if (!secretKey || typeof secretKey !== 'string') {
    throw new Error('makeClerkOAuthAdapter: CLERK_SECRET_KEY is required (non-empty string)');
  }
  const clerk = createClerkClient({ secretKey });

  async function getAccessToken(
    userId: UserId,
    provider: OAuthProvider,
    opts: ClerkOAuthAdapterOptions = {},
  ): Promise<OAuthAccessTokenSnapshot> {
    if (!OAUTH_PROVIDER_TO_CLERK_SLUG[provider]) {
      throw buildError(
        'OAUTH_INVALID_PROVIDER',
        `Provider '${provider}' is not in the R50.3a OAuthProvider taxonomy. Valid: ${Object.keys(OAUTH_PROVIDER_TO_CLERK_SLUG).join(', ')}`,
        { user_id: userId },
      );
    }
    const ttlSeconds = opts.cache_ttl_seconds ?? DEFAULT_CACHE_TTL_SECONDS;

    if (!opts.force_refresh && ttlSeconds > 0) {
      const key = cacheKey(userId, provider);
      const cached = tokenCache.get(key);
      if (cached && cached.expires_at_ms > Date.now()) {
        return cached.snapshot;
      }
    }

    const clerkSlug = OAUTH_PROVIDER_TO_CLERK_SLUG[provider];
    let resp;
    try {
      // Wave λ-tail (postmortem cons #2): Clerk SDK has two overloads —
      // one expects `oauth_<name>` template, the other expects the legacy
      // OAuthProvider union (bare names: 'github' | 'google' | ...). Our
      // OAUTH_PROVIDER_TO_CLERK_SLUG values are bare names, matching the
      // legacy overload. The map's value type is `string` (per its
      // `Record<OAuthProvider,string>` declaration) so we cast to the
      // SDK's union via `unknown` to bridge widening.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resp = await (clerk.users.getUserOauthAccessToken as any)(userId, clerkSlug);
    } catch (raw) {
      throw mapClerkError(raw, provider, userId);
    }

    // Clerk v1 returns { data: OauthAccessToken[], totalCount } (paginated).
    // Earlier v0 returned a bare array; the SDK normalizes but we handle both
    // for defense-in-depth.
    const tokens = Array.isArray(resp) ? resp : (resp as { data: unknown[] })?.data || [];
    if (tokens.length === 0) {
      throw buildError(
        'OAUTH_NOT_CONNECTED',
        `Clerk returned empty token list for ${userId}/${provider}; user has not authorized this provider`,
        { provider, user_id: userId },
      );
    }
    const t = tokens[0] as {
      provider?: string;
      token?: string;
      externalAccountId?: string;
      scopes?: string[];
      label?: string;
    };
    if (!t.token) {
      throw buildError(
        'OAUTH_TOKEN_EXPIRED',
        `Clerk returned a token row for ${userId}/${provider} but the token field is empty (expired and not refreshable)`,
        { provider, user_id: userId },
      );
    }

    const snapshot: OAuthAccessTokenSnapshot = {
      provider,
      token: t.token,
      external_account_id: t.externalAccountId || '',
      scopes: Array.isArray(t.scopes) ? t.scopes : [],
      label: t.label ?? null,
      fetched_at: new Date().toISOString(),
    };

    if (ttlSeconds > 0) {
      tokenCache.set(cacheKey(userId, provider), {
        snapshot,
        expires_at_ms: Date.now() + ttlSeconds * 1000,
      });
    }

    return snapshot;
  }

  async function listConnectedProviders(userId: UserId): Promise<string[]> {
    try {
      const user = await clerk.users.getUser(userId);
      const accounts = (user as { externalAccounts?: Array<{ provider?: string }> }).externalAccounts || [];
      return accounts
        .map(a => (a.provider || '').replace(/^oauth_/, ''))
        .filter(Boolean);
    } catch (raw) {
      // listConnectedProviders is best-effort; map any failure to a typed error.
      // Caller (route handler) decides whether to short-circuit or proceed.
      throw mapClerkError(raw, 'github' /* placeholder; not the actual failed provider */, userId);
    }
  }

  function invalidateCache(userId: UserId, provider: OAuthProvider): void {
    tokenCache.delete(cacheKey(userId, provider));
  }

  return { getAccessToken, listConnectedProviders, invalidateCache };
}

// Re-export error helpers for routes that want to construct adapter errors
// directly (e.g. when a route's own validation fails before the adapter is called).
export { buildError as buildOAuthAdapterError };
