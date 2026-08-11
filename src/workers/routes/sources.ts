// sources.ts · GET/POST/DELETE /api/v1/sources/* (R50.3b)
//
// Authority: dedicated connector OAuth for Gmail/Drive; legacy identity-backed
// authorization remains only for providers not yet migrated.
//
// Routes:
//   GET    /api/v1/sources                 list user's connected sources
//   GET    /api/v1/sources/:id/repos       list a github source's repos (repo picker)
//   POST   /api/v1/sources/connect/:provider  materialize DB row from Clerk state
//   DELETE /api/v1/sources/:id             revoke upstream grant, then soft-disconnect
//   POST   /api/v1/sources/:id/sync        verify token + mark last_sync_at
//
// AUTH: all routes require Clerk-authenticated identity. Dedicated OAuth grants
// are tenant + user scoped; legacy connections retain their prior user scope.
//
// CONTRACT: this route surface is purely the OPERATOR-facing REST API. Actual
// per-provider event ingestion (calling GitHub/Google/Dropbox APIs with the
// retrieved token) lives in R50.3c translators. R50.3d cron handles
// scheduled sync; this route exposes manual-sync.

import { Hono } from 'hono';
import { envFlagTrue } from '../lib/env-flag';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { withAuthority } from '../lib/allowed-actions';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { OAuthProvider, UserSourceConnection, SourceReadPolicy, SourceOAuthTokenAdapter } from '../dal/types';
import { OAUTH_PROVIDER_TO_CLERK_SLUG } from '../dal/types';
import { withIdempotency } from '../lib/idempotency'; // G2 · Idempotency-Key on the access-level PATCH
import { makeClerkOAuthAdapter } from '../dal/clerk-oauth-adapter';
import { getTranslator } from '../sources/translators';
import { listUserRepos } from '../sources/translators/github';
import type { TranslatorResult } from '../sources/translators/types';
import { buildConnectorCatalog, CONNECTOR_REGISTRY } from '../lib/connector-registry';
import { emitEvent } from '../lib/observability'; // T3/P6 · source-sync outcome events
import { listProviderFolders, FOLDER_PROVIDERS } from '../sources/folder-pickers';
import {
  connectorOAuthGrantId,
  connectorOAuthNonceHash,
  isConnectorOAuthEncryptionConfigured,
  openConnectorOAuthState,
  openConnectorTokens,
  sealConnectorOAuthState,
  sealConnectorTokens,
  type ConnectorOAuthEncryptionEnv,
} from '../lib/connector-oauth-crypto';
import {
  createCodeVerifier,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationUrl,
  googleConnectorScopes,
  isGoogleConnectorOAuthConfigured,
  revokeGoogleGrant,
  type ConnectorOAuthProviderEnv,
} from '../services/connector-oauth-provider';
import { makeConnectorOAuthGrantAdapter, type ConnectorOAuthRuntimeEnv } from '../dal/connector-oauth-adapter';

export interface SourcesEnv extends AuthEnv, ConnectorOAuthEncryptionEnv, ConnectorOAuthProviderEnv {
  DATABASE_URL: string;
  CLERK_SECRET_KEY: string;
  /**
   * Explicit deployment proof that connector providers are configured as
   * link-only in Clerk and are not accepted as sign-in methods.
   */
  CONNECTOR_OAUTH_REVOCATION_MODE?: string;
  /** Activates the Xlooop-owned Google connector authorization broker. */
  CONNECTOR_OAUTH_AUTHORITY_MODE?: string;
}

export interface SourcesVariables extends AuthVariables {
  dal: DalAdapter;
}

export const sourcesRoute = new Hono<{ Bindings: SourcesEnv; Variables: SourcesVariables }>();

const VALID_PROVIDERS: ReadonlySet<OAuthProvider> = new Set([
  // 260701 · gmail + outlook were added to OAuthProvider, the connector-registry, the translator
  // registry + the migration (#795/S5b) but MISSED here — so POST /sources/connect/gmail was rejected
  // 400 (a Drive connect succeeded, Gmail did not, on the SAME Google token). Keep this list in lockstep
  // with the OAuthProvider union so a connectable provider can actually materialize its row.
  'github', 'google_drive', 'gmail', 'dropbox', 'gitlab', 'microsoft_onedrive', 'outlook',
]);

function isValidProvider(s: string): s is OAuthProvider {
  return VALID_PROVIDERS.has(s as OAuthProvider);
}

function isDedicatedGoogleProvider(provider: OAuthProvider): provider is 'google_drive' | 'gmail' {
  return provider === 'google_drive' || provider === 'gmail';
}

function connectorTokenAdapter(
  env: SourcesEnv,
  dal: DalAdapter,
  userId: string,
  source: UserSourceConnection,
): SourceOAuthTokenAdapter {
  if (source.oauth_grant_id) {
    if (!source.workspace_id || !isDedicatedGoogleProvider(source.provider)) {
      throw Object.assign(new Error('dedicated connector grant binding is invalid'), { code: 'OAUTH_GRANT_BINDING_INVALID' });
    }
    return makeConnectorOAuthGrantAdapter({
      dal,
      env: env as ConnectorOAuthRuntimeEnv,
      workspace_id: source.workspace_id,
      user_id: userId,
      grant_id: source.oauth_grant_id,
    });
  }
  if (!env.CLERK_SECRET_KEY) {
    throw Object.assign(new Error('CLERK_SECRET_KEY not configured'), { code: 'CONFIG_ERROR' });
  }
  return makeClerkOAuthAdapter(env.CLERK_SECRET_KEY);
}

function sourceMatchesActiveWorkspace(
  source: Pick<UserSourceConnection, 'workspace_id'>,
  workspaceId: string | null | undefined,
): boolean {
  return workspaceId
    ? source.workspace_id === workspaceId
    : source.workspace_id == null;
}

function requireCompleteSyncReceipt(write: {
  source_sync_receipt_id?: string;
  operation_event_id?: string;
  audit_event_id?: string;
  projection_outbox_id?: string;
}): void {
  if (
    !write.source_sync_receipt_id ||
    !write.operation_event_id ||
    !write.audit_event_id ||
    !write.projection_outbox_id
  ) {
    throw new Error('SOURCE_RECEIPT_MISSING: source sync did not produce complete event, audit, and outbox lineage');
  }
}

// ============================================================
// GET /api/v1/connectors · Wave C2 · connector registry SSOT
// ============================================================
// Serves the static connector catalog (provider metadata: id, label, description, tier, clerk_slug,
// capability) so the frontend modal is data-driven instead of hardcoding the provider list — one place
// to add a provider. No user data; returns the frozen registry verbatim.
sourcesRoute.get('/connectors', (ctx) => {
  return ctx.json(buildConnectorCatalog());
});

/** Public response shape (matches the DAL row, but renames a few fields for clarity at the wire). */
function toApiResponse(c: UserSourceConnection) {
  return {
    id: c.id,
    workspace_id: c.workspace_id,
    workspace_binding: c.workspace_id ? 'workspace_bound' : 'legacy_user_account_unbound',
    credential_authority: c.oauth_grant_id ? 'xlooop_connector_grant' : 'legacy_identity_provider',
    provider: c.provider,
    provider_username: c.provider_username,
    scopes: c.scopes,
    status: c.status,
    contract: c.contract,
    read_policy: c.read_policy, // G2 · access tier (metadata_only/read_only/proposal_only → Index/Rely/Operate)
    connected_at: c.connected_at,
    last_sync_at: c.last_sync_at,
    last_sync_error: c.last_sync_error,
  };
}

// G2 (write 25) · the UI sends an access LEVEL (index/rely/operate); the backend persists the equivalent
// read_policy. This is the ONLY place the level↔policy mapping lives (source-tier.ts maps back the other
// way for grounding). Keep the two in lockstep: index↔metadata_only, rely↔read_only, operate↔proposal_only.
const LEVEL_TO_READ_POLICY: Record<string, SourceReadPolicy> = {
  index: 'metadata_only',
  rely: 'read_only',
  operate: 'proposal_only',
};

// ============================================================
// GET /api/v1/sources
// ============================================================
//
// Returns tenant-filtered connection metadata only. Credential state is
// authoritative in the dedicated encrypted grant store when oauth_grant_id is
// present; legacy providers retain their identity-provider token authority.
sourcesRoute.get('/sources', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const dal = ctx.get('dal');
    const rows = await dal.listUserSources(auth.user_id);
    const scoped = rows.filter((source) => sourceMatchesActiveWorkspace(source, auth.workspace_id));
    return ctx.json(withDataClass(withAuthority({ sources: scoped.map(toApiResponse) }, auth, 'source'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// GET /api/v1/sources/:id/repos
// ============================================================
//
// Lists the repositories the connected GitHub source can access, so the
// operator can PICK a specific repo to bind to a project
// (project_source_bindings, via POST /projects/:id/sources). GitHub-only for
// now (the only provider with a repo concept). Mirrors the /sync route's
// ownership-verify + token-retrieval pattern; the OAuth connection is
// USER-scoped, so we verify the source row belongs to the auth'd user first.
sourcesRoute.get('/sources/:id/repos', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const id = ctx.req.param('id');
    if (!id) {
      return errorEnvelope(ctx, { status: 400, code: 'INVALID_ID', message: 'id path param required' });
    }
    const dal = ctx.get('dal');
    const existing = await dal.getUserSource(auth.user_id, id);
    if (!existing || !sourceMatchesActiveWorkspace(existing, auth.workspace_id)) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
    }
    if (existing.provider !== 'github') {
      return errorEnvelope(ctx, { status: 400, code: 'UNSUPPORTED_PROVIDER', message: `repo listing is only supported for github (source is ${existing.provider})` });
    }
    const adapter = connectorTokenAdapter(ctx.env, dal, auth.user_id, existing);
    let token: string;
    try {
      const snap = await adapter.getAccessToken(auth.user_id, 'github');
      token = snap.token;
    } catch (err) {
      return errorEnvelope(ctx, { status: 502, code: 'OAUTH_TOKEN_ERROR', message: `could not retrieve GitHub token: ${(err as Error).message}` });
    }
    try {
      const repos = await listUserRepos(token);
      return ctx.json({ repos, source_id: id, provider: 'github' });
    } catch (err) {
      const code = (err as { code?: string }).code || 'github_api_error';
      const status = code === 'github_api_unauthorized' ? 401 : code === 'github_api_rate_limited' ? 429 : 502;
      return errorEnvelope(ctx, { status, code: code.toUpperCase(), message: (err as Error).message });
    }
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// GET /api/v1/sources/:id/folders · Wave C3 · folder picker (Drive / Dropbox)
// ============================================================
// The non-GitHub equivalent of /repos: list the connected source's folders (metadata only) so the
// operator can bind ONE folder instead of the whole account. USER-scoped; verifies ownership first.
sourcesRoute.get('/sources/:id/folders', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const id = ctx.req.param('id');
    if (!id) {
      return errorEnvelope(ctx, { status: 400, code: 'INVALID_ID', message: 'id path param required' });
    }
    const dal = ctx.get('dal');
    const existing = await dal.getUserSource(auth.user_id, id);
    if (!existing || !sourceMatchesActiveWorkspace(existing, auth.workspace_id)) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
    }
    if (!FOLDER_PROVIDERS.has(existing.provider)) {
      return errorEnvelope(ctx, { status: 400, code: 'UNSUPPORTED_PROVIDER', message: `folder listing is only supported for Google Drive / Dropbox (source is ${existing.provider})` });
    }
    const adapter = connectorTokenAdapter(ctx.env, dal, auth.user_id, existing);
    let token: string;
    try {
      const snap = await adapter.getAccessToken(auth.user_id, existing.provider);
      token = snap.token;
    } catch (err) {
      return errorEnvelope(ctx, { status: 502, code: 'OAUTH_TOKEN_ERROR', message: `could not retrieve ${existing.provider} token: ${(err as Error).message}` });
    }
    try {
      const folders = await listProviderFolders(existing.provider, token);
      return ctx.json({ folders, source_id: id, provider: existing.provider });
    } catch (err) {
      const code = (err as { code?: string }).code || 'folder_api_error';
      const status = /unauthorized/.test(code) ? 401 : /rate_limited/.test(code) ? 429 : 502;
      return errorEnvelope(ctx, { status, code: code.toUpperCase(), message: (err as Error).message });
    }
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// POST /api/v1/sources/oauth/:provider/start|complete
// ============================================================
// Dedicated connector authorization. Clerk remains identity-only; the provider
// refresh token is purpose-bound, encrypted, tenant/user scoped, and never sent
// back to the browser.
sourcesRoute.post('/sources/oauth/:provider/start', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const provider = ctx.req.param('provider') as OAuthProvider;
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    if (!auth.workspace_id) {
      return errorEnvelope(ctx, { status: 409, code: 'SOURCE_WORKSPACE_BINDING_REQUIRED', message: 'A tenant workspace is required for connector authorization.' });
    }
    if (!isDedicatedGoogleProvider(provider)) {
      return errorEnvelope(ctx, { status: 400, code: 'CONNECTOR_OAUTH_PROVIDER_UNAVAILABLE', message: 'Dedicated connector OAuth currently supports Google Drive and Gmail.' });
    }
    if (ctx.env.CONNECTOR_OAUTH_AUTHORITY_MODE !== 'dedicated_google') {
      return errorEnvelope(ctx, { status: 503, code: 'CONNECTOR_OAUTH_BROKER_UNAVAILABLE', message: 'Dedicated connector authorization is not enabled for this deployment.' });
    }
    if (!await isConnectorOAuthEncryptionConfigured(ctx.env) || !isGoogleConnectorOAuthConfigured(ctx.env)) {
      return errorEnvelope(ctx, { status: 503, code: 'CONNECTOR_OAUTH_BROKER_UNAVAILABLE', message: 'Connector authorization keys or provider configuration are incomplete.' });
    }
    const dal = ctx.get('dal');
    const authority = await dal.getCustomerAuthorityState(auth.workspace_id);
    if (!authority.unlocked) {
      return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'AUTHORITY_REQUIRED: workspace authority and consent must be recorded before connecting resources.' });
    }
    const codeVerifier = createCodeVerifier();
    const nonce = crypto.randomUUID();
    const expiresAtMs = Date.now() + 10 * 60 * 1000;
    const redirectUri = String(ctx.env.CONNECTOR_OAUTH_REDIRECT_URI || '');
    const state = await sealConnectorOAuthState(ctx.env.CONNECTOR_OAUTH_STATE_KEY, {
      user_id: auth.user_id,
      workspace_id: auth.workspace_id,
      provider,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      nonce,
      expires_at_ms: expiresAtMs,
    });
    await dal.registerConnectorOAuthStateNonce({
      nonce_hash: await connectorOAuthNonceHash(nonce),
      workspace_id: auth.workspace_id,
      user_id: auth.user_id,
      provider,
      expires_at: new Date(expiresAtMs).toISOString(),
    });
    const authorizationUrl = await googleAuthorizationUrl(ctx.env, provider, state, codeVerifier);
    return ctx.json({
      provider,
      authorization_url: authorizationUrl,
      expires_at: new Date(expiresAtMs).toISOString(),
      request_id: ctx.get('request_id'),
      credential_authority: 'xlooop_connector_grant',
    }, 201);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

sourcesRoute.post('/sources/oauth/:provider/complete', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const provider = ctx.req.param('provider') as OAuthProvider;
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    if (!auth.workspace_id) {
      return errorEnvelope(ctx, { status: 409, code: 'SOURCE_WORKSPACE_BINDING_REQUIRED', message: 'A tenant workspace is required for connector authorization.' });
    }
    if (!isDedicatedGoogleProvider(provider)) {
      return errorEnvelope(ctx, { status: 400, code: 'CONNECTOR_OAUTH_PROVIDER_UNAVAILABLE', message: 'Dedicated connector OAuth currently supports Google Drive and Gmail.' });
    }
    if (ctx.env.CONNECTOR_OAUTH_AUTHORITY_MODE !== 'dedicated_google') {
      return errorEnvelope(ctx, { status: 503, code: 'CONNECTOR_OAUTH_BROKER_UNAVAILABLE', message: 'Dedicated connector authorization is not enabled for this deployment.' });
    }
    const body = await ctx.req.json().catch(() => null) as { code?: unknown; state?: unknown } | null;
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const stateValue = typeof body?.state === 'string' ? body.state : '';
    if (!code || !stateValue) {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'OAuth code and state are required.' });
    }
    const state = await openConnectorOAuthState(ctx.env.CONNECTOR_OAUTH_STATE_KEY, stateValue);
    if (
      !state ||
      state.user_id !== auth.user_id ||
      state.workspace_id !== auth.workspace_id ||
      state.provider !== provider ||
      state.redirect_uri !== ctx.env.CONNECTOR_OAUTH_REDIRECT_URI
    ) {
      return errorEnvelope(ctx, { status: 400, code: 'CONNECTOR_OAUTH_STATE_INVALID', message: 'Connector authorization state is invalid or expired.' });
    }
    const dal = ctx.get('dal');
    const claimed = await dal.claimConnectorOAuthStateNonce({
      nonce_hash: await connectorOAuthNonceHash(state.nonce),
      workspace_id: auth.workspace_id,
      user_id: auth.user_id,
      provider,
    });
    if (!claimed) {
      return errorEnvelope(ctx, { status: 409, code: 'CONNECTOR_OAUTH_STATE_REPLAYED', message: 'Connector authorization state was already used or expired.' });
    }
    const exchange = await exchangeGoogleAuthorizationCode(
      ctx.env,
      provider,
      code,
      state.code_verifier,
    );
    const grantId = await connectorOAuthGrantId({
      workspace_id: auth.workspace_id,
      user_id: auth.user_id,
      authority_provider: exchange.authority_provider,
      provider_account_id: exchange.provider_account_id,
    });
    const priorGrant = await dal.getConnectorOAuthGrantSecret(auth.workspace_id, auth.user_id, grantId);
    const requiredScopes = googleConnectorScopes(provider);
    const missingScopes = requiredScopes.filter((scope) => !exchange.tokens.scopes.includes(scope));
    if (missingScopes.length) {
      if (!priorGrant) await revokeGoogleGrant(ctx.env, exchange.tokens).catch(() => undefined);
      return errorEnvelope(ctx, { status: 422, code: 'SOURCE_SCOPE_MISSING', message: `${provider} authorization omitted required scopes: ${missingScopes.join(', ')}` });
    }
    const existing = (await dal.listUserSources(auth.user_id)).find((source) =>
      source.provider === provider && source.workspace_id === auth.workspace_id,
    );
    if (existing?.oauth_grant_id && existing.oauth_grant_id !== grantId) {
      if (!priorGrant) await revokeGoogleGrant(ctx.env, exchange.tokens).catch(() => undefined);
      return errorEnvelope(ctx, {
        status: 409,
        code: 'SOURCE_ACCOUNT_SWITCH_REQUIRES_DISCONNECT',
        message: 'Disconnect the current provider account before authorizing a different account.',
      });
    }
    const sealed = await sealConnectorTokens(
      ctx.env,
      exchange.tokens,
      { workspace_id: auth.workspace_id, user_id: auth.user_id, grant_id: grantId },
    );
    try {
      const write = await dal.connectConnectorOAuthSource({
        id: grantId,
        workspace_id: auth.workspace_id,
        user_id: auth.user_id,
        authority_provider: exchange.authority_provider,
        provider_account_id: exchange.provider_account_id,
        provider_label: exchange.provider_label,
        scopes: exchange.tokens.scopes,
        token_ciphertext: sealed.ciphertext,
        token_iv: sealed.iv,
        access_expires_at: exchange.tokens.expires_at,
        source_provider: provider,
      });
      return ctx.json({
        source: toApiResponse(write.source),
        source_binding_id: write.source_binding_id,
        connector_grant_receipt_id: write.connector_grant_receipt_id,
        audit_event_id: write.audit_event_id,
      }, 201);
    } catch (error) {
      if (!priorGrant) await revokeGoogleGrant(ctx.env, exchange.tokens).catch(() => undefined);
      throw error;
    }
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// POST /api/v1/sources/connect/:provider (legacy identity-backed path)
// ============================================================
//
// Flow:
//   1. Frontend uses Clerk's user.createExternalAccount({ strategy: 'oauth_<provider>' })
//      OR Clerk's hosted Account Portal to authorize the provider
//   2. After Clerk completes the OAuth dance, frontend POSTs HERE to
//      materialize the user_source_connections DB row
//   3. We verify Clerk has the external account on this user, then upsert
//
// We do NOT initiate the OAuth dance from the backend — Clerk's frontend
// SDK handles redirect-back semantics; the backend's role is just to
// confirm + persist the binding fact.
sourcesRoute.post('/sources/connect/:provider', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const provider = ctx.req.param('provider') as string;
    if (!isValidProvider(provider)) {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'INVALID_PROVIDER',
        message: `provider must be one of: ${Array.from(VALID_PROVIDERS).join(', ')}; got: ${provider}`,
      });
    }

    if (isDedicatedGoogleProvider(provider) && ctx.env.CONNECTOR_OAUTH_AUTHORITY_MODE === 'dedicated_google') {
      return errorEnvelope(ctx, {
        status: 409,
        code: 'USE_DEDICATED_CONNECTOR_OAUTH',
        message: `Start ${provider} authorization through /api/v1/sources/oauth/${provider}/start; Clerk sign-in identity is not connector authority.`,
      });
    }

    // R55 · IP-boundary hard-gate (CUSTOMER_ECOSYSTEM_ONBOARDING_AND_IP_BOUNDARY_STANDARD): a company
    // workspace must have a recorded authority + consent record before private connectors can be
    // materialized. Orgless (personal) sessions are not gated — there is no company ecosystem to govern.
    if (auth.workspace_id) {
      const authority = await ctx.get('dal').getCustomerAuthorityState(auth.workspace_id);
      if (!authority.unlocked) {
        return errorEnvelope(ctx, {
          status: 403,
          code: 'FORBIDDEN',
          message: 'AUTHORITY_REQUIRED: connecting resources is locked until your workspace authority and consent are recorded.',
        });
      }
    }

    const secretKey = ctx.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      return errorEnvelope(ctx, { status: 500, code: 'CONFIG_ERROR', message: 'CLERK_SECRET_KEY not configured' });
    }

    const adapter = makeClerkOAuthAdapter(secretKey);
    // Fetch a token to verify the user actually has this provider connected
    // in Clerk. If they don't, the adapter throws OAUTH_NOT_CONNECTED.
    let snapshot;
    try {
      snapshot = await adapter.getAccessToken(auth.user_id, provider, { force_refresh: true });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const code = e.code || 'OAUTH_CLERK_API_ERROR';
      // Map adapter error codes to HTTP statuses
      const status = code === 'OAUTH_NOT_CONNECTED' ? 404
        : code === 'OAUTH_REVOKED' ? 410
        : code === 'OAUTH_PROVIDER_NOT_CONFIGURED' ? 503
        : code === 'OAUTH_INVALID_PROVIDER' ? 400
        : 502;
      return errorEnvelope(ctx, { status, code, message: e.message || 'oauth error' });
    }

    // T1/P3 (260710) · restricted-scope guard, flag-gated (SOURCE_SCOPE_ENFORCEMENT_ENABLED, default OFF —
    // byte-identical). For a `connect_time_only` provider (gmail), the connection must actually CARRY its
    // restricted scope(s) before we materialize a source row — otherwise the row claims a capability
    // (mailbox read) the token can't exercise, and the translator would fail downstream. This is the
    // backend half of the scope split (the FE requests the scope only at Connect, never at sign-in).
    if (envFlagTrue((ctx.env as { SOURCE_SCOPE_ENFORCEMENT_ENABLED?: string }).SOURCE_SCOPE_ENFORCEMENT_ENABLED)) {
      const desc = CONNECTOR_REGISTRY.find((c) => c.id === provider);
      const required = desc?.restricted_scope_mode === 'connect_time_only' ? (desc.restricted_scopes ?? []) : [];
      if (required.length) {
        const granted = (snapshot.scopes || []).map(String);
        const missing = required.filter((r) => {
          const short = r.split('/').pop() || r; // 'gmail.readonly'
          return !granted.some((g) => g === r || g.includes(short));
        });
        if (missing.length) {
          return errorEnvelope(ctx, {
            status: 422, code: 'SOURCE_SCOPE_MISSING',
            message: `${provider} requires the restricted scope(s) ${missing.join(', ')} — reconnect via the source picker (which requests them at connect time)`,
          });
        }
      }
    }

    // Upsert the DB row. The unique constraint on (user_id, provider) means
    // a re-connect of an existing provider updates scopes/external_account_id
    // rather than duplicating.
    const dal = ctx.get('dal');
    const activeProviderSource = (await dal.listUserSources(auth.user_id))
      .find((source) => source.provider === provider);
    if (
      auth.workspace_id &&
      activeProviderSource?.workspace_id &&
      activeProviderSource.workspace_id !== auth.workspace_id
    ) {
      return errorEnvelope(ctx, {
        status: 409,
        code: 'SOURCE_BOUND_TO_OTHER_WORKSPACE',
        message: `${provider} is already bound to another workspace; disconnect it there before reconnecting here`,
      });
    }
    const write = await dal.upsertUserSource({
      // OAuth identity is user-owned, but customer ingestion must have an explicit tenant target.
      // Orgless operator sessions remain user-account scoped; workspace sessions bind to that workspace.
      workspace_id: auth.workspace_id || null,
      user_id: auth.user_id,
      provider,
      provider_user_id: snapshot.external_account_id,
      provider_username: snapshot.label, // Clerk's label is the username/email shown to user
      scopes: snapshot.scopes,
      // contract: omitted · DB default applies (migration 008)
    });
    return ctx.json({
      source: toApiResponse(write.source),
      source_binding_id: write.source_binding_id,
      source_connection_receipt_id: write.source_connection_receipt_id,
      audit_event_id: write.audit_event_id,
    }, 201);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// DELETE /api/v1/sources/:id
// ============================================================
//
// Commercial invariant: disconnect means the upstream grant is absent, not
// merely that Xlooop hid its local row. Dedicated Google grants retain a shared
// Drive/Gmail grant until its final source is disconnected, then revoke and
// verify it before the atomic local write. Legacy Clerk external accounts may
// also be login identities, so that path remains link-only and fail-closed.
sourcesRoute.delete('/sources/:id', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const id = ctx.req.param('id');
    if (!id) {
      return errorEnvelope(ctx, { status: 400, code: 'INVALID_ID', message: 'id path param required' });
    }
    const dal = ctx.get('dal');
    // Verify ownership before delete (returns 404 if not found OR owned by different user)
    const existing = await dal.getUserSource(auth.user_id, id);
    if (!existing || !sourceMatchesActiveWorkspace(existing, auth.workspace_id)) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
    }
    if (existing.oauth_grant_id) {
      if (!existing.workspace_id || !isDedicatedGoogleProvider(existing.provider)) {
        return errorEnvelope(ctx, { status: 409, code: 'OAUTH_GRANT_BINDING_INVALID', message: 'Dedicated connector grant binding is incomplete; no source state was changed.' });
      }
      const activeReferences = await dal.countActiveConnectorGrantSources(
        existing.workspace_id,
        auth.user_id,
        existing.oauth_grant_id,
      );
      if (activeReferences > 1) {
        const retained = {
          authority: 'xlooop_connector_grant' as const,
          authority_mode: 'dedicated_connector' as const,
          oauth_grant_id: existing.oauth_grant_id,
          upstream_status: 'retained_shared' as const,
          identity_preserved: true as const,
          upstream_verified_at: new Date().toISOString(),
          request_id: ctx.get('request_id') || null,
        };
        const write = await dal.disconnectConnectorOAuthSource({
          workspace_id: existing.workspace_id,
          user_id: auth.user_id,
          source_id: id,
          authority: retained,
        });
        return ctx.json({ ...write, upstream_revocation: retained });
      }
      if (activeReferences !== 1) {
        return errorEnvelope(ctx, { status: 409, code: 'SOURCE_GRANT_CARDINALITY_CHANGED', message: 'Connector grant state changed; retry disconnect.' });
      }
      const grant = await dal.getConnectorOAuthGrantSecret(existing.workspace_id, auth.user_id, existing.oauth_grant_id);
      if (!grant || grant.status === 'revoked') {
        return errorEnvelope(ctx, { status: 409, code: 'SOURCE_GRANT_RECONNECT_REQUIRED', message: 'Connector grant is absent or already revoked; reconnect before changing source state.' });
      }
      let tokens;
      try {
        tokens = await openConnectorTokens(
          ctx.env,
          { ciphertext: grant.token_ciphertext, iv: grant.token_iv },
          { workspace_id: existing.workspace_id, user_id: auth.user_id, grant_id: existing.oauth_grant_id },
        );
      } catch {
        return errorEnvelope(ctx, { status: 502, code: 'OAUTH_TOKEN_DECRYPTION_FAILED', message: 'Connector grant could not be opened; no source state was changed.' });
      }
      let upstream;
      try {
        upstream = await revokeGoogleGrant(ctx.env, tokens);
      } catch (error) {
        return errorEnvelope(ctx, { status: 502, code: 'CONNECTOR_OAUTH_REVOCATION_FAILED', message: `${(error as Error).message}. No source state was changed.` });
      }
      const authority = {
        authority: 'xlooop_connector_grant' as const,
        authority_mode: 'dedicated_connector' as const,
        oauth_grant_id: existing.oauth_grant_id,
        upstream_status: upstream.status,
        identity_preserved: true as const,
        upstream_verified_at: upstream.verified_at,
        request_id: ctx.get('request_id') || null,
      };
      const write = await dal.disconnectConnectorOAuthSource({
        workspace_id: existing.workspace_id,
        user_id: auth.user_id,
        source_id: id,
        authority,
      });
      return ctx.json({ ...write, upstream_revocation: authority });
    }
    if (ctx.env.CONNECTOR_OAUTH_REVOCATION_MODE !== 'clerk_link_only') {
      return errorEnvelope(ctx, {
        status: 409,
        code: 'SOURCE_IDENTITY_CONNECTOR_SEPARATION_REQUIRED',
        message: 'Disconnect is blocked because connector OAuth and sign-in identity have not been proven separate. No source state was changed.',
      });
    }
    if (!existing.provider_user_id) {
      return errorEnvelope(ctx, {
        status: 409,
        code: 'SOURCE_RECONNECT_REQUIRED',
        message: 'This legacy source has no upstream account identifier. Reconnect it before revocation; no source state was changed.',
      });
    }
    const shared = (await dal.listUserSources(auth.user_id)).filter((source) =>
      source.id !== existing.id &&
      source.provider_user_id === existing.provider_user_id,
    );
    if (shared.length > 0) {
      return errorEnvelope(ctx, {
        status: 409,
        code: 'SOURCE_SHARED_UPSTREAM_GRANT',
        message: `This OAuth grant is shared by ${[existing.provider, ...shared.map((source) => source.provider)].join(', ')}. Revoke the connector group together; no source state was changed.`,
      });
    }
    const secretKey = ctx.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      return errorEnvelope(ctx, { status: 500, code: 'CONFIG_ERROR', message: 'CLERK_SECRET_KEY not configured' });
    }
    const adapter = makeClerkOAuthAdapter(secretKey);
    let upstream;
    try {
      upstream = await adapter.revokeLinkOnlyGrant(auth.user_id, existing.provider, existing.provider_user_id);
    } catch (err) {
      const oauth = err as { code?: string; message?: string };
      const status = oauth.code === 'OAUTH_IDENTITY_FALLBACK_REQUIRED' || oauth.code === 'OAUTH_EXTERNAL_ACCOUNT_ID_REQUIRED'
        ? 409
        : 502;
      return errorEnvelope(ctx, {
        status,
        code: oauth.code || 'OAUTH_CLERK_API_ERROR',
        message: `${oauth.message || 'Upstream OAuth revocation failed'}. No source state was changed.`,
      });
    }
    const write = await dal.disconnectUserSource(
      auth.user_id,
      id,
      auth.workspace_id || existing.workspace_id || null,
      {
        authority: upstream.authority,
        authority_mode: upstream.authority_mode,
        external_account_id: upstream.external_account_id,
        upstream_status: upstream.status,
        identity_preserved: upstream.identity_preserved,
        upstream_verified_at: upstream.verified_at,
        request_id: ctx.get('request_id') || null,
      },
    );
    if (!write.source_disconnect_receipt_id || !write.audit_event_id) {
      return errorEnvelope(ctx, { status: 500, code: 'SOURCE_RECEIPT_MISSING', message: 'source disconnect did not produce an audit receipt' });
    }
    return ctx.json({ ...write, upstream_revocation: upstream });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// PATCH /api/v1/sources/:id  · G2 (write 25) · set the source access tier
// ============================================================
//
// The NEW-UI "access level" control (Index / Rely / Operate) was optimistic-only (no column to persist).
// This PATCH persists the equivalent read_policy. Accepts EITHER `{read_policy}` (the canonical 016
// enum) OR the UI's `{level}` (index/rely/operate, mapped here). USER-scoped ownership (dal.getUserSource
// → 404, same as DELETE). 422 on a bad value. Idempotency-Key honoured (flag-gated, byte-identical off).
// Best-effort operation_events mirror so the re-tier is auditable server-side (like the DELETE mirror).
sourcesRoute.patch('/sources/:id', (ctx) => withIdempotency(ctx, 'PATCH /api/v1/sources/:id', async () => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const id = ctx.req.param('id');
    if (!id) {
      return errorEnvelope(ctx, { status: 400, code: 'INVALID_ID', message: 'id path param required' });
    }
    const body = (await ctx.req.json().catch(() => null)) as { read_policy?: unknown; level?: unknown } | null;
    // Resolve the target policy from read_policy (canonical) OR level (UI). read_policy wins if both sent.
    let policy: SourceReadPolicy | null = null;
    const rp = body && typeof body.read_policy === 'string' ? body.read_policy : '';
    const lvl = body && typeof body.level === 'string' ? body.level.toLowerCase() : '';
    if (rp) {
      if (rp === 'metadata_only' || rp === 'read_only' || rp === 'proposal_only') policy = rp;
    } else if (lvl) {
      policy = LEVEL_TO_READ_POLICY[lvl] ?? null;
    }
    if (!policy) {
      return errorEnvelope(ctx, {
        status: 422, code: 'INVALID_READ_POLICY',
        message: 'read_policy must be one of metadata_only, read_only, proposal_only (or level index, rely, operate)',
      });
    }
    const dal = ctx.get('dal');
    // Ownership 404 first (mirror DELETE): a missing / not-owned id is indistinguishable to the caller.
    const existing = await dal.getUserSource(auth.user_id, id);
    if (!existing || !sourceMatchesActiveWorkspace(existing, auth.workspace_id)) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
    }
    let updated: UserSourceConnection;
    try {
      const write = await dal.plan.setUserSourceReadPolicy(auth.user_id, id, policy, auth.workspace_id || existing.workspace_id || null);
      if (!write.read_policy_revision_id || !write.audit_event_id) {
        return errorEnvelope(ctx, { status: 500, code: 'SOURCE_RECEIPT_MISSING', message: 'source access-level change did not produce an audit receipt' });
      }
      updated = write.source;
      return ctx.json({
        source: toApiResponse(updated),
        read_policy_revision_id: write.read_policy_revision_id,
        audit_event_id: write.audit_event_id,
      });
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      if (e.code === 'READ_POLICY_UNAVAILABLE' || e.status === 409) {
        return errorEnvelope(ctx, { status: 409, code: 'READ_POLICY_UNAVAILABLE', message: e.message || 'source access-level persistence is not enabled yet' });
      }
      if (e.status === 404) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
      if (e.status === 422) return errorEnvelope(ctx, { status: 422, code: 'INVALID_READ_POLICY', message: e.message || 'invalid read_policy' });
      throw err;
    }
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
}));

// ============================================================
// POST /api/v1/sources/:id/sync
// ============================================================
//
// Manual sync trigger (R50.3d — IMPLEMENTED, not a placeholder):
//   1. Resolve getTranslator(provider) and invoke it to ingest provider events, with a
//      workspace-binding guard, then mark last_sync_at = now().
//   2. On failure, fall back to verifying the token is still retrievable and record last_sync_error.
//   Success/failure both emit an observability event. (Doc corrected 260711-J / ROUTE-02.)
sourcesRoute.post('/sources/:id/sync', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const id = ctx.req.param('id');
    if (!id) {
      return errorEnvelope(ctx, { status: 400, code: 'INVALID_ID', message: 'id path param required' });
    }
    const dal = ctx.get('dal');
    const existing = await dal.getUserSource(auth.user_id, id);
    if (!existing) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
    }
    if (!existing.workspace_id) {
      return errorEnvelope(ctx, {
        status: 409,
        code: 'SOURCE_WORKSPACE_BINDING_REQUIRED',
        message: 'SOURCE_WORKSPACE_BINDING_REQUIRED: reconnect this legacy source from the active workspace before syncing it.',
      });
    }
    if (!sourceMatchesActiveWorkspace(existing, auth.workspace_id)) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
    }
    const targetWorkspaceId = existing.workspace_id;
    const authorityFor = (emittedEvents: TranslatorResult['emitted_events'] = []) => ({
      operation_event_id: crypto.randomUUID(),
      projection_outbox_id: crypto.randomUUID(),
      request_id: ctx.get('request_id') || null,
      source_tool: existing.provider,
      emitted_events: emittedEvents,
    });

    // R50.3d · "sync" = verify the OAuth token is still valid, THEN invoke the
    // per-provider translator (R50.3c) to ingest provider metadata into
    // operation_events (the translator writes via the DAL). Token-only verify
    // remains the fallback for any provider without a registered translator.
    const adapter = connectorTokenAdapter(ctx.env, dal, auth.user_id, existing);
    try {
      await adapter.getAccessToken(auth.user_id, existing.provider, { force_refresh: true });
    } catch (err) {
      const msg = (err as Error).message || 'unknown error';
      const failureWrite = await dal.markUserSourceSync(
        auth.user_id,
        id,
        { success: false, error: msg },
        targetWorkspaceId,
        authorityFor(),
      );
      requireCompleteSyncReceipt(failureWrite);
      const e = err as { code?: string };
      return errorEnvelope(ctx, { status: 502, code: e.code || 'OAUTH_TOKEN_ERROR', message: msg });
    }

    let sync: TranslatorResult | null = null;
    const translator = getTranslator(existing.provider);
    if (translator) {
      try {
        sync = await translator({
          adapter,
          dal,
          userSource: { ...existing, workspace_id: targetWorkspaceId },
          // Incremental: events since the last successful sync (30-day
          // first-run lookback when never synced).
          since: existing.last_sync_at || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        });
        if (sync.errors.length > 0 && sync.events_emitted === 0) {
          throw new Error(sync.errors.map((error) => `${error.code}: ${error.message}`).join('; '));
        }
        const write = await dal.markUserSourceSync(
          auth.user_id,
          id,
          { success: true },
          targetWorkspaceId,
          authorityFor(sync.emitted_events),
        );
        requireCompleteSyncReceipt(write);
        emitEvent('source_sync_completed', { provider: existing.provider, workspace_id: existing.workspace_id ?? auth.workspace_id ?? null, events: (sync as { events?: unknown[] })?.events?.length ?? 0 }); // T3/P6
        const refreshed = await dal.getUserSource(auth.user_id, id);
        return ctx.json({
          source: refreshed ? toApiResponse(refreshed) : null,
          sync,
          source_sync_receipt_id: write.source_sync_receipt_id,
          operation_event_id: write.operation_event_id,
          audit_event_id: write.audit_event_id,
          projection_outbox_id: write.projection_outbox_id,
        });
      } catch (err) {
        const msg = (err as Error).message || 'translator error';
        const failureWrite = await dal.markUserSourceSync(
          auth.user_id,
          id,
          { success: false, error: msg },
          targetWorkspaceId,
          authorityFor(sync?.emitted_events),
        );
        requireCompleteSyncReceipt(failureWrite);
        emitEvent('source_sync_failed', { provider: existing.provider, workspace_id: existing.workspace_id ?? auth.workspace_id ?? null, error: msg.slice(0, 200) }); // T3/P6
        return errorEnvelope(ctx, { status: 502, code: 'SOURCE_SYNC_ERROR', message: msg });
      }
    } else {
      const write = await dal.markUserSourceSync(
        auth.user_id,
        id,
        { success: true },
        targetWorkspaceId,
        authorityFor(),
      );
      requireCompleteSyncReceipt(write);
      const refreshed = await dal.getUserSource(auth.user_id, id);
      return ctx.json({
        source: refreshed ? toApiResponse(refreshed) : null,
        sync,
        source_sync_receipt_id: write.source_sync_receipt_id,
        operation_event_id: write.operation_event_id,
        audit_event_id: write.audit_event_id,
        projection_outbox_id: write.projection_outbox_id,
      });
    }
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
