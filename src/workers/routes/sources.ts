// sources.ts · GET/POST/DELETE /api/v1/sources/* (R50.3b)
//
// Authority: R50 plan stage R50.3b · CLERK_OAUTH_PROVIDER_CONFIG.md
//
// Routes:
//   GET    /api/v1/sources                 list user's connected sources
//   GET    /api/v1/sources/:id/repos       list a github source's repos (repo picker)
//   POST   /api/v1/sources/connect/:provider  materialize DB row from Clerk state
//   DELETE /api/v1/sources/:id             disconnect a source (remove DB row)
//   POST   /api/v1/sources/:id/sync        verify token + mark last_sync_at
//
// AUTH: all routes require Clerk-authenticated user; routes are USER-scoped
// (not workspace-scoped) because OAuth connections belong to the user account.
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
import type { OAuthProvider, UserSourceConnection, SourceReadPolicy } from '../dal/types';
import { OAUTH_PROVIDER_TO_CLERK_SLUG } from '../dal/types';
import { withIdempotency } from '../lib/idempotency'; // G2 · Idempotency-Key on the access-level PATCH
import { makeClerkOAuthAdapter } from '../dal/clerk-oauth-adapter';
import { getTranslator } from '../sources/translators';
import { listUserRepos } from '../sources/translators/github';
import type { TranslatorResult } from '../sources/translators/types';
import { buildConnectorCatalog, CONNECTOR_REGISTRY } from '../lib/connector-registry';
import { emitEvent } from '../lib/observability'; // T3/P6 · source-sync outcome events
import { listProviderFolders, FOLDER_PROVIDERS } from '../sources/folder-pickers';

export interface SourcesEnv extends AuthEnv {
  DATABASE_URL: string;
  CLERK_SECRET_KEY: string;
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
// Returns the DB rows verbatim. Does NOT re-query Clerk on every list call
// for two reasons:
//   1. Cost (Clerk free tier rate limit is 100 req/10s/IP)
//   2. Single source of truth — the DB row is authoritative for sync state
//      (last_sync_at, last_sync_error); Clerk is authoritative for token state
// The POST /connect/:provider route handles initial materialization from
// Clerk. If the user disconnects in Clerk's dashboard, our DB row remains
// until the next sync attempt fails — at which point status='error' surfaces
// the discrepancy in the UI.
sourcesRoute.get('/sources', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const dal = ctx.get('dal');
    const rows = await dal.listUserSources(auth.user_id);
    return ctx.json(withDataClass(withAuthority({ sources: rows.map(toApiResponse) }, auth, 'source'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
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
    if (!existing) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
    }
    if (existing.provider !== 'github') {
      return errorEnvelope(ctx, { status: 400, code: 'UNSUPPORTED_PROVIDER', message: `repo listing is only supported for github (source is ${existing.provider})` });
    }
    const secretKey = ctx.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      return errorEnvelope(ctx, { status: 500, code: 'CONFIG_ERROR', message: 'CLERK_SECRET_KEY not configured' });
    }
    const adapter = makeClerkOAuthAdapter(secretKey);
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
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
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
    if (!existing) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
    }
    if (!FOLDER_PROVIDERS.has(existing.provider)) {
      return errorEnvelope(ctx, { status: 400, code: 'UNSUPPORTED_PROVIDER', message: `folder listing is only supported for Google Drive / Dropbox (source is ${existing.provider})` });
    }
    const secretKey = ctx.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      return errorEnvelope(ctx, { status: 500, code: 'CONFIG_ERROR', message: 'CLERK_SECRET_KEY not configured' });
    }
    const adapter = makeClerkOAuthAdapter(secretKey);
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
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
  }
});

// ============================================================
// POST /api/v1/sources/connect/:provider
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
    const row = await dal.upsertUserSource({
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
    return ctx.json({ source: toApiResponse(row) }, 201);
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
  }
});

// ============================================================
// DELETE /api/v1/sources/:id
// ============================================================
//
// Removes the DB row. Does NOT revoke at Clerk — operator must do that
// at https://accounts.xlooop.com → Account → Connections (Clerk hosted).
// The next call to POST /sources/connect/:provider will materialize a
// fresh row if the operator re-authorizes.
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
    if (!existing) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
    }
    await dal.disconnectUserSource(auth.user_id, id);
    // Recoverability doctrine (260706): this is currently a HARD delete (R50.3b operator-intended
    // semantics — row removal IS the "I'm done with this source" gesture), which also destroys the
    // customer's visibility of the action. Mirror it onto the customer-visible operation_events
    // spine so the disconnect is at least AUDITABLE server-side even though the row is gone.
    // (Soft-delete conversion is a separate operator-dispositioned change — see plan P1a.)
    // Best-effort: never block the disconnect; requires a workspace scope to attribute the event.
    try {
      if (auth.workspace_id) {
        await dal.upsertEvent(auth.workspace_id, {
          id: `evt_source_disconnect_${id}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
          source_tool: 'xlooop',
          agent_id: 'xlooop:operator-action',
          status: 'completed',
          summary: `[source disconnected] ${String(existing.provider || 'source')}`.slice(0, 512),
          body: 'OAuth source row removed (hard delete per R50.3b). Clerk-side authorization must be revoked separately at accounts.xlooop.com.',
          visibility: 'internal_workspace',
          occurred_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn('[sources] disconnect event mirror failed (best-effort)', { user_id: auth.user_id, error: (err as Error)?.message });
    }
    return ctx.json({ disconnected: { id, provider: existing.provider } });
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
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
    if (!existing) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
    }
    let updated: UserSourceConnection;
    try {
      updated = await dal.plan.setUserSourceReadPolicy(auth.user_id, id, policy);
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      if (e.code === 'READ_POLICY_UNAVAILABLE' || e.status === 409) {
        return errorEnvelope(ctx, { status: 409, code: 'READ_POLICY_UNAVAILABLE', message: e.message || 'source access-level persistence is not enabled yet' });
      }
      if (e.status === 404) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `source ${id} not found` });
      if (e.status === 422) return errorEnvelope(ctx, { status: 422, code: 'INVALID_READ_POLICY', message: e.message || 'invalid read_policy' });
      throw err;
    }
    // Best-effort audit mirror onto the customer-visible spine (requires a workspace to attribute).
    try {
      if (auth.workspace_id) {
        await dal.upsertEvent(auth.workspace_id, {
          id: `evt_source_retier_${id}_${policy}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
          source_tool: 'xlooop',
          agent_id: 'xlooop:operator-action',
          status: 'completed',
          summary: `[source access-level] ${String(existing.provider || 'source')} -> ${policy}`.slice(0, 512),
          body: `Source read_policy set to ${policy} (access tier). Governs grounding weight per source-tier.ts.`,
          visibility: 'internal_workspace',
          occurred_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn('[sources] read_policy event mirror failed (best-effort)', { user_id: auth.user_id, error: (err as Error)?.message });
    }
    return ctx.json({ source: toApiResponse(updated) });
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
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

    const secretKey = ctx.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      return errorEnvelope(ctx, { status: 500, code: 'CONFIG_ERROR', message: 'CLERK_SECRET_KEY not configured' });
    }

    // R50.3d · "sync" = verify the OAuth token is still valid, THEN invoke the
    // per-provider translator (R50.3c) to ingest provider metadata into
    // operation_events (the translator writes via the DAL). Token-only verify
    // remains the fallback for any provider without a registered translator.
    const adapter = makeClerkOAuthAdapter(secretKey);
    try {
      await adapter.getAccessToken(auth.user_id, existing.provider, { force_refresh: true });
    } catch (err) {
      const msg = (err as Error).message || 'unknown error';
      await dal.markUserSourceSync(auth.user_id, id, { success: false, error: msg });
      const e = err as { code?: string };
      return errorEnvelope(ctx, { status: 502, code: e.code || 'OAUTH_CLERK_API_ERROR', message: msg });
    }

    let sync: TranslatorResult | null = null;
    const translator = getTranslator(existing.provider);
    if (translator) {
      try {
        const targetWorkspaceId = existing.workspace_id || auth.workspace_id || null;
        if (!targetWorkspaceId) {
          const msg = 'SOURCE_WORKSPACE_BINDING_REQUIRED: source sync needs a workspace target before provider events can be ingested.';
          await dal.markUserSourceSync(auth.user_id, id, { success: false, error: msg });
          return errorEnvelope(ctx, { status: 409, code: 'SOURCE_WORKSPACE_BINDING_REQUIRED', message: msg });
        }
        sync = await translator({
          adapter,
          dal,
          userSource: { ...existing, workspace_id: targetWorkspaceId },
          // Incremental: events since the last successful sync (30-day
          // first-run lookback when never synced).
          since: existing.last_sync_at || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        });
        await dal.markUserSourceSync(auth.user_id, id, { success: true });
        emitEvent('source_sync_completed', { provider: existing.provider, workspace_id: existing.workspace_id ?? auth.workspace_id ?? null, events: (sync as { events?: unknown[] })?.events?.length ?? 0 }); // T3/P6
      } catch (err) {
        const msg = (err as Error).message || 'translator error';
        await dal.markUserSourceSync(auth.user_id, id, { success: false, error: msg });
        emitEvent('source_sync_failed', { provider: existing.provider, workspace_id: existing.workspace_id ?? auth.workspace_id ?? null, error: msg.slice(0, 200) }); // T3/P6
        return errorEnvelope(ctx, { status: 502, code: 'SOURCE_SYNC_ERROR', message: msg });
      }
    } else {
      await dal.markUserSourceSync(auth.user_id, id, { success: true });
    }

    const refreshed = await dal.getUserSource(auth.user_id, id);
    return ctx.json({ source: refreshed ? toApiResponse(refreshed) : null, sync });
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
  }
});
