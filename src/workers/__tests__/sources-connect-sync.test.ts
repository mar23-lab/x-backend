// sources-connect-sync.test.ts · W2 (2026-06-15) · connector materialize + sync happy/error paths
//
// The audit found the connect→materialize→sync chain at ~0% backend coverage (only the authority
// gate was tested). These integration tests exercise the route handlers with the Clerk OAuth adapter
// + translator registry mocked (no network), so a regression in the materialize/sync surface is
// caught by CI instead of by the operator in production (the failure mode that produced #703/#705).
//
// Authority: src/workers/routes/sources.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable OAuth adapter: 'ok' returns a token snapshot; 'fail' throws a coded error.
const oauthState: { mode: 'ok' | 'fail'; failCode?: string } = { mode: 'ok' };
const translatorState: { translator: null | ((input: any) => Promise<any>); lastInput: any | null } = { translator: null, lastInput: null };
vi.mock('../dal/clerk-oauth-adapter', () => ({
  makeClerkOAuthAdapter: () => ({
    getAccessToken: async () => {
      if (oauthState.mode === 'fail') {
        const e = new Error('token rejected') as Error & { code?: string };
        e.code = oauthState.failCode || 'OAUTH_CLERK_API_ERROR';
        throw e;
      }
      return { external_account_id: 'eacc_1', label: 'octocat', scopes: ['repo'], token: 't_x' };
    },
  }),
}));

// Default: no registered translator → sync verifies the token then marks success (no provider-API network).
vi.mock('../sources/translators', () => ({
  getTranslator: () => translatorState.translator
    ? async (input: any) => {
      translatorState.lastInput = input;
      return translatorState.translator!(input);
    }
    : null,
}));

import { Hono } from 'hono';
import { sourcesRoute } from '../routes/sources';

const ENV = { CLERK_SECRET_KEY: 'sk_test_x', DATABASE_URL: 'postgres://test' };
const UNLOCKED = {
  workspace_id: 'org_acme', unlocked: true, operator_approved: true, consent_acked: true,
  allowed_modes: [], allowed_apps: [], consent: null,
};
const sourceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'src_1', workspace_id: 'org_acme', provider: 'github', provider_username: 'octocat', scopes: ['repo'],
  status: 'connected', contract: 'metadata_only', read_policy: 'metadata_only', connected_at: '2026-01-01T00:00:00Z',
  user_id: 'u1', last_sync_at: null, last_sync_error: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});
const connectReceipt = (source: Record<string, unknown>) => ({
  source,
  source_binding_id: source.id,
  source_connection_receipt_id: `source-connect:${source.id}:audit_source_connect`,
  audit_event_id: 'audit_source_connect',
});
const syncReceipt = (id = 'src_1') => ({
  source_sync_receipt_id: `source-sync:${id}:success:audit_source_sync`,
  audit_event_id: 'audit_source_sync',
});

function appFor(auth: Record<string, unknown>, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', sourcesRoute);
  return app;
}

beforeEach(() => {
  oauthState.mode = 'ok';
  oauthState.failCode = undefined;
  translatorState.translator = null;
  translatorState.lastInput = null;
});

describe('POST /sources/connect/:provider · materialize (happy path)', () => {
  it('201 upserts the user_source row when the Clerk OAuth token is retrievable', async () => {
    const upsertUserSource = vi.fn(async () => connectReceipt(sourceRow()));
    const app = appFor(
      { user_id: 'u1', workspace_id: 'org_acme' },
      { getCustomerAuthorityState: async () => UNLOCKED, upsertUserSource }
    );
    const res = await app.request('/api/v1/sources/connect/github', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, any>;
    expect(json.source).toBeTruthy();
    expect(json.source.id).toBe('src_1');
    expect(json.source_connection_receipt_id).toBe('source-connect:src_1:audit_source_connect');
    expect(json.audit_event_id).toBe('audit_source_connect');
    expect(upsertUserSource).toHaveBeenCalledOnce();
    // The materialize must persist the Clerk external-account identity, not a silent placeholder.
    expect(upsertUserSource.mock.calls[0][0]).toMatchObject({
      workspace_id: 'org_acme', user_id: 'u1', provider: 'github', provider_user_id: 'eacc_1', provider_username: 'octocat',
    });
  });

  it('keeps orgless connections user-scoped', async () => {
    const upsertUserSource = vi.fn(async () => connectReceipt(sourceRow({ workspace_id: null })));
    const app = appFor(
      { user_id: 'u1', workspace_id: '' },
      { upsertUserSource }
    );
    const res = await app.request('/api/v1/sources/connect/github', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(201);
    expect(upsertUserSource.mock.calls[0][0]).toMatchObject({ workspace_id: null, user_id: 'u1', provider: 'github' });
  });
});

describe('POST /sources/:id/sync', () => {
  it('404 when the source is not found for this user', async () => {
    const app = appFor({ user_id: 'u1', workspace_id: 'org_acme' }, { getUserSource: async () => null });
    const res = await app.request('/api/v1/sources/src_missing/sync', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(404);
  });

  it('502 + records last_sync_error when the OAuth token fetch fails', async () => {
    oauthState.mode = 'fail';
    const markUserSourceSync = vi.fn(async () => syncReceipt());
    const app = appFor(
      { user_id: 'u1', workspace_id: 'org_acme' },
      { getUserSource: async () => sourceRow(), markUserSourceSync }
    );
    const res = await app.request('/api/v1/sources/src_1/sync', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(502);
    expect(markUserSourceSync).toHaveBeenCalledWith('u1', 'src_1', expect.objectContaining({ success: false }), 'org_acme');
  });

  it('200 + records sync success when the token is valid and no translator is registered', async () => {
    const markUserSourceSync = vi.fn(async () => syncReceipt());
    const src = sourceRow();
    const app = appFor(
      { user_id: 'u1', workspace_id: 'org_acme' },
      { getUserSource: async () => src, markUserSourceSync }
    );
    const res = await app.request('/api/v1/sources/src_1/sync', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>;
    expect(json.source_sync_receipt_id).toBe('source-sync:src_1:success:audit_source_sync');
    expect(json.audit_event_id).toBe('audit_source_sync');
    expect(markUserSourceSync).toHaveBeenCalledWith('u1', 'src_1', expect.objectContaining({ success: true }), 'org_acme');
  });

  it('passes the signed-in workspace as translator target for legacy user-scoped rows', async () => {
    translatorState.translator = async () => ({ events_emitted: 0, events_rejected: 0, errors: [], completed_at: '2026-07-01T00:00:00Z' });
    const markUserSourceSync = vi.fn(async () => syncReceipt());
    const src = sourceRow({
      workspace_id: null, provider: 'gmail', provider_username: 'me@gmail.test', scopes: ['gmail.readonly'],
      status: 'connected', contract: { version: 1, ingestion_mode: 'reflection_only', allowed_fields: [], max_body_bytes: 200, rate_limit: { per_hour: 5000 } },
    });
    const app = appFor(
      { user_id: 'u1', workspace_id: 'org_acme' },
      { getUserSource: async () => src, markUserSourceSync }
    );
    const res = await app.request('/api/v1/sources/src_1/sync', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(200);
    expect(translatorState.lastInput.userSource.workspace_id).toBe('org_acme');
    expect(markUserSourceSync).toHaveBeenCalledWith('u1', 'src_1', expect.objectContaining({ success: true }), 'org_acme');
  });

  it('409 + records sync error when a translator source has no workspace target', async () => {
    translatorState.translator = async () => ({ events_emitted: 0, events_rejected: 0, errors: [], completed_at: '2026-07-01T00:00:00Z' });
    const markUserSourceSync = vi.fn(async () => syncReceipt());
    const src = sourceRow({
      workspace_id: null, provider: 'gmail', provider_username: 'me@gmail.test', scopes: ['gmail.readonly'],
      status: 'connected', contract: { version: 1, ingestion_mode: 'reflection_only', allowed_fields: [], max_body_bytes: 200, rate_limit: { per_hour: 5000 } },
    });
    const app = appFor(
      { user_id: 'u1', workspace_id: '' },
      { getUserSource: async () => src, markUserSourceSync }
    );
    const res = await app.request('/api/v1/sources/src_1/sync', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(409);
    expect(translatorState.lastInput).toBeNull();
    expect(markUserSourceSync).toHaveBeenCalledWith('u1', 'src_1', expect.objectContaining({ success: false }), null);
  });

  it('401 when unauthenticated', async () => {
    const app = appFor({}, {});
    const res = await app.request('/api/v1/sources/src_1/sync', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /sources/:id · audited disconnect', () => {
  it('200 + returns a source disconnect receipt before the UI may remove local state', async () => {
    const disconnectUserSource = vi.fn(async () => ({
      disconnected: { id: 'src_1', provider: 'github' },
      source_disconnect_receipt_id: 'source-disconnect:src_1:audit_source_disconnect',
      audit_event_id: 'audit_source_disconnect',
    }));
    const app = appFor(
      { user_id: 'u1', workspace_id: 'org_acme' },
      { getUserSource: async () => sourceRow(), disconnectUserSource }
    );
    const res = await app.request('/api/v1/sources/src_1', { method: 'DELETE' }, ENV as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>;
    expect(json.source_disconnect_receipt_id).toBe('source-disconnect:src_1:audit_source_disconnect');
    expect(json.audit_event_id).toBe('audit_source_disconnect');
    expect(disconnectUserSource).toHaveBeenCalledWith('u1', 'src_1', 'org_acme');
  });

  it('500 when the DAL cannot provide an audit receipt', async () => {
    const app = appFor(
      { user_id: 'u1', workspace_id: 'org_acme' },
      { getUserSource: async () => sourceRow(), disconnectUserSource: async () => ({ disconnected: { id: 'src_1', provider: 'github' } }) }
    );
    const res = await app.request('/api/v1/sources/src_1', { method: 'DELETE' }, ENV as never);
    expect(res.status).toBe(500);
    const json = (await res.json()) as Record<string, any>;
    expect(json.code).toBe('SOURCE_RECEIPT_MISSING');
  });
});

// ── T1/P3 (260710) · restricted-scope guard on connect (SOURCE_SCOPE_ENFORCEMENT_ENABLED) ─────────
describe('POST /sources/connect/gmail · restricted-scope guard', () => {
  const upsertGmail = () => vi.fn(async () => ({
    source: sourceRow({ id: 'src_g', workspace_id: 'org_acme', provider: 'gmail', provider_username: 'me@gmail.test' }),
    source_binding_id: 'src_g',
    source_connection_receipt_id: 'source-connect:src_g:audit_source_connect',
    audit_event_id: 'audit_source_connect',
  }));

  it('flag ON + granted scopes MISSING gmail.readonly → 422 SOURCE_SCOPE_MISSING, row NOT materialized', async () => {
    const upsertUserSource = upsertGmail();
    const app = appFor({ user_id: 'u1', workspace_id: 'org_acme' }, { getCustomerAuthorityState: async () => UNLOCKED, upsertUserSource });
    // the shared adapter mock grants scopes ['repo'] — no gmail.readonly
    const res = await app.request('/api/v1/sources/connect/gmail', { method: 'POST' }, { ...ENV, SOURCE_SCOPE_ENFORCEMENT_ENABLED: 'true' } as never);
    expect(res.status).toBe(422);
    const json = (await res.json()) as Record<string, any>;
    expect(json.code).toBe('SOURCE_SCOPE_MISSING');
    expect(upsertUserSource).not.toHaveBeenCalled(); // fail-closed: no row claiming a capability the token lacks
  });

  it('flag OFF (default): byte-identical — the connect materializes exactly as today', async () => {
    const upsertUserSource = upsertGmail();
    const app = appFor({ user_id: 'u1', workspace_id: 'org_acme' }, { getCustomerAuthorityState: async () => UNLOCKED, upsertUserSource });
    const res = await app.request('/api/v1/sources/connect/gmail', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(201);
    expect(upsertUserSource).toHaveBeenCalledOnce();
  });

  it('flag ON does not affect providers WITHOUT a restricted scope (github still 201)', async () => {
    const upsertUserSource = vi.fn(async () => connectReceipt(sourceRow()));
    const app = appFor({ user_id: 'u1', workspace_id: 'org_acme' }, { getCustomerAuthorityState: async () => UNLOCKED, upsertUserSource });
    const res = await app.request('/api/v1/sources/connect/github', { method: 'POST' }, { ...ENV, SOURCE_SCOPE_ENFORCEMENT_ENABLED: 'true' } as never);
    expect(res.status).toBe(201);
  });
});
