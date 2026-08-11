import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sourcesRoute } from '../routes/sources';
import { sealConnectorTokens } from '../lib/connector-oauth-crypto';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64url');
const ENV = {
  DATABASE_URL: 'postgres://test',
  CLERK_SECRET_KEY: 'sk_test_identity_only',
  CONNECTOR_OAUTH_AUTHORITY_MODE: 'dedicated_google',
  CONNECTOR_OAUTH_ENC_KEYS: JSON.stringify({ c1: key(1) }),
  CONNECTOR_OAUTH_ACTIVE_KEY_ID: 'c1',
  CONNECTOR_OAUTH_STATE_KEY: key(2),
  CONNECTOR_GOOGLE_CLIENT_ID: 'google-client',
  CONNECTOR_GOOGLE_CLIENT_SECRET: 'google-secret',
  CONNECTOR_GOOGLE_OAUTH_VERIFICATION_STATUS: 'pilot_test_users',
  CONNECTOR_OAUTH_REDIRECT_URI: 'https://app.xlooop.com/settings/integrations',
};
const AUTH = { user_id: 'user_1', workspace_id: 'org_acme', role: 'owner' };
const UNLOCKED = { workspace_id: 'org_acme', unlocked: true };

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'src_gmail', workspace_id: 'org_acme', user_id: 'user_1', provider: 'gmail',
    provider_user_id: 'acct_1', provider_username: 'person@example.com', oauth_grant_id: 'cog_1',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly'],
    contract: { version: 1, ingestion_mode: 'reflection_only', allowed_fields: [], max_body_bytes: 200, rate_limit: { per_hour: 5000 } },
    status: 'connected', read_policy: 'metadata_only', connected_at: '2026-08-11T00:00:00.000Z',
    last_sync_at: null, last_sync_error: null, created_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

function appFor(dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'req_connector');
    ctx.set('auth', AUTH as never);
    ctx.set('dal', { listUserSources: async () => [], ...dal } as never);
    await next();
  });
  app.route('/api/v1', sourcesRoute);
  return app;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dedicated connector OAuth routes', () => {
  it('starts and completes an authenticated one-time Gmail grant without Clerk connector authority', async () => {
    const registerNonce = vi.fn(async () => undefined);
    const claimNonce = vi.fn(async () => true);
    const connectSource = vi.fn(async (input: Record<string, unknown>) => ({
      grant: { id: input.id },
      source: source({ oauth_grant_id: input.id }),
      source_binding_id: 'src_gmail',
      connector_grant_receipt_id: `connector-grant:${input.id}:audit_1`,
      audit_event_id: 'audit_1',
    }));
    const app = appFor({
      getCustomerAuthorityState: async () => UNLOCKED,
      registerConnectorOAuthStateNonce: registerNonce,
      claimConnectorOAuthStateNonce: claimNonce,
      getConnectorOAuthGrantSecret: async () => null,
      connectConnectorOAuthSource: connectSource,
    });
    const start = await app.request('/api/v1/sources/oauth/gmail/start', { method: 'POST' }, ENV as never);
    expect(start.status).toBe(201);
    const started = await start.json() as { authorization_url: string; credential_authority: string };
    const authorization = new URL(started.authorization_url);
    expect(started.credential_authority).toBe('xlooop_connector_grant');
    expect(authorization.searchParams.get('scope')).toContain('gmail.readonly');
    expect(registerNonce).toHaveBeenCalledOnce();

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600,
        scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'acct_1', email: 'person@example.com' }), { status: 200 })));
    const complete = await app.request('/api/v1/sources/oauth/gmail/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'code_1', state: authorization.searchParams.get('state') }),
    }, ENV as never);
    expect(complete.status).toBe(201);
    const completed = await complete.json() as Record<string, unknown>;
    expect(completed).toMatchObject({
      source_binding_id: 'src_gmail', audit_event_id: 'audit_1',
    });
    expect((completed.source as Record<string, unknown>).credential_authority).toBe('xlooop_connector_grant');
    expect(claimNonce).toHaveBeenCalledOnce();
    expect(connectSource).toHaveBeenCalledOnce();
    const persisted = connectSource.mock.calls[0][0] as Record<string, unknown>;
    expect(String(persisted.token_ciphertext)).not.toContain('refresh');
    expect(persisted).not.toHaveProperty('access_token');
    expect(persisted).not.toHaveProperty('refresh_token');
  });

  it('rejects callback replay before provider exchange', async () => {
    const app = appFor({
      getCustomerAuthorityState: async () => UNLOCKED,
      registerConnectorOAuthStateNonce: async () => undefined,
      claimConnectorOAuthStateNonce: async () => false,
    });
    const start = await app.request('/api/v1/sources/oauth/google_drive/start', { method: 'POST' }, ENV as never);
    const authorization = new URL((await start.json() as { authorization_url: string }).authorization_url);
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const complete = await app.request('/api/v1/sources/oauth/google_drive/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'code_1', state: authorization.searchParams.get('state') }),
    }, ENV as never);
    expect(complete.status).toBe(409);
    expect(await complete.json()).toMatchObject({ code: 'CONNECTOR_OAUTH_STATE_REPLAYED' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('blocks the legacy Clerk materialization path when dedicated Google authority is active', async () => {
    const app = appFor({ getCustomerAuthorityState: async () => UNLOCKED });
    const result = await app.request('/api/v1/sources/connect/gmail', { method: 'POST' }, ENV as never);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'USE_DEDICATED_CONNECTOR_OAUTH' });
  });

  it('disconnects one shared source while retaining the common Google grant', async () => {
    const disconnect = vi.fn(async () => ({
      disconnected: { id: 'src_gmail', provider: 'gmail' }, disconnected_source_ids: ['src_gmail'],
      grant_status: 'active', source_disconnect_receipt_id: 'source-disconnect:src_gmail:audit_2', audit_event_id: 'audit_2',
    }));
    const app = appFor({
      getUserSource: async () => source(),
      countActiveConnectorGrantSources: async () => 2,
      disconnectConnectorOAuthSource: disconnect,
    });
    const result = await app.request('/api/v1/sources/src_gmail', { method: 'DELETE' }, ENV as never);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ grant_status: 'active', upstream_revocation: { upstream_status: 'retained_shared' } });
    expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({
      authority: expect.objectContaining({ upstream_status: 'retained_shared', identity_preserved: true }),
    }));
  });

  it('revokes and verifies the upstream grant before disconnecting the last source', async () => {
    const tokens = {
      access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer',
      expires_at: '2026-08-11T12:00:00.000Z', scopes: ['openid', 'email'],
    };
    const sealed = await sealConnectorTokens(ENV, tokens, { workspace_id: 'org_acme', user_id: 'user_1', grant_id: 'cog_1' });
    const disconnect = vi.fn(async () => ({
      disconnected: { id: 'src_gmail', provider: 'gmail' }, disconnected_source_ids: ['src_gmail'],
      grant_status: 'revoked', source_disconnect_receipt_id: 'source-disconnect:src_gmail:audit_3', audit_event_id: 'audit_3',
    }));
    const app = appFor({
      getUserSource: async () => source(),
      countActiveConnectorGrantSources: async () => 1,
      getConnectorOAuthGrantSecret: async () => ({ ...source(), id: 'cog_1', authority_provider: 'google', provider_account_id: 'acct_1', provider_label: null, access_expires_at: tokens.expires_at, status: 'active', last_refresh_at: null, last_refresh_error: null, revocation_verified_at: null, token_ciphertext: sealed.ciphertext, token_iv: sealed.iv }),
      disconnectConnectorOAuthSource: disconnect,
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));
    const result = await app.request('/api/v1/sources/src_gmail', { method: 'DELETE' }, ENV as never);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ grant_status: 'revoked', upstream_revocation: { upstream_status: 'revoked' } });
    expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({
      authority: expect.objectContaining({ upstream_status: 'revoked', identity_preserved: true }),
    }));
  });
});
