import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { settingsReadinessRoute } from '../routes/settings-readiness';

const AUTH = {
  user_id: 'user_a', workspace_id: 'workspace_a', role: 'owner', auth_method: 'clerk_jwt',
};
const key = (fill: number) => Buffer.alloc(32, fill).toString('base64url');

function dal(overrides: Record<string, unknown> = {}) {
  return {
    getSessionEntitlement: vi.fn(async () => ({ state: 'approved_workspace' })),
    modelRuntimes: {
      listProviders: vi.fn(async () => []),
      getOverride: vi.fn(async () => null),
      getProviderCredential: vi.fn(async () => null),
    },
    listUserSources: vi.fn(async () => [{
      workspace_id: 'workspace_a', status: 'connected', connected_at: '2026-08-08T00:00:00Z',
      last_sync_at: '2026-08-09T00:00:00Z', last_sync_error: null,
    }]),
    listEvidenceItems: vi.fn(async () => []),
    ...overrides,
  };
}

function appFor(currentDal: Record<string, unknown>, auth: Record<string, unknown> = AUTH) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'request_readiness_1');
    ctx.set('auth', auth as never);
    ctx.set('dal', currentDal as never);
    await next();
  });
  app.route('/api/v1', settingsReadinessRoute);
  return app;
}

describe('GET /api/v1/settings/readiness', () => {
  it('returns nine tenant-safe live checks and never invents lifecycle readiness', async () => {
    const res = await appFor(dal()).request('/api/v1/settings/readiness', {}, {
      DATABASE_URL: 'postgres://redacted',
      XLOOOP_RLS_APP_DATABASE_URL: 'postgres://redacted-app-role',
      XLOOOP_AUTHORITY_MODE: 'production',
      XLOOOP_SCHEMA_HEAD: '93',
      SINGLE_INTAKE_ENABLED: 'true',
      CONNECTOR_OAUTH_AUTHORITY_MODE: 'dedicated_google',
      CONNECTOR_OAUTH_ENC_KEYS: JSON.stringify({ c1: key(1) }),
      CONNECTOR_OAUTH_ACTIVE_KEY_ID: 'c1',
      CONNECTOR_OAUTH_STATE_KEY: key(2),
      CONNECTOR_GOOGLE_CLIENT_ID: 'client-id',
      CONNECTOR_GOOGLE_CLIENT_SECRET: 'client-secret',
      CONNECTOR_GOOGLE_OAUTH_VERIFICATION_STATUS: 'verified',
      CONNECTOR_OAUTH_REDIRECT_URI: 'https://app.xlooop.com/settings/integrations',
      AI: { run: async () => ({ response: 'live' }) },
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.schema_id).toBe('xlooop.settings_readiness.v1');
    expect(body.checks.map((item: any) => item.id)).toEqual([
      'auth_tenant', 'api_gateway', 'database_schema_rls', 'effective_runtime',
      'mcp_oauth', 'sources_freshness', 'connector_revocation', 'telemetry', 'delete_export',
    ]);
    expect(body.checks.find((item: any) => item.id === 'database_schema_rls')).toMatchObject({
      status: 'ready', details: { schema_head: 93, rls_binding: 'app' },
    });
    expect(body.checks.find((item: any) => item.id === 'effective_runtime')).toMatchObject({
      status: 'ready',
      details: {
        policy_enforcement: {
          status: 'enforced',
          authority: 'xlooop_backend',
          mutable: false,
        },
      },
    });
    expect(body.checks.find((item: any) => item.id === 'delete_export').status).toBe('attention');
    expect(body.checks.find((item: any) => item.id === 'connector_revocation')).toMatchObject({
      status: 'ready', details: {
        authority_mode: 'dedicated_google',
        shared_grant_policy: 'retain_until_last_source_then_revoke',
        encryption_ready: true,
        provider_ready: true,
        canary_ready: true,
        commercial_authorization_ready: true,
        oauth_verification_status: 'verified',
      },
    });
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('keeps a test-user canary visibly below commercial readiness', async () => {
    const res = await appFor(dal()).request('/api/v1/settings/readiness', {}, {
      DATABASE_URL: 'postgres://redacted',
      XLOOOP_RLS_APP_DATABASE_URL: 'postgres://redacted-app-role',
      XLOOOP_SCHEMA_HEAD: '101',
      SINGLE_INTAKE_ENABLED: 'true',
      CONNECTOR_OAUTH_AUTHORITY_MODE: 'dedicated_google',
      CONNECTOR_OAUTH_ENC_KEYS: JSON.stringify({ c1: key(1) }),
      CONNECTOR_OAUTH_ACTIVE_KEY_ID: 'c1',
      CONNECTOR_OAUTH_STATE_KEY: key(2),
      CONNECTOR_GOOGLE_CLIENT_ID: 'client-id',
      CONNECTOR_GOOGLE_CLIENT_SECRET: 'client-secret',
      CONNECTOR_GOOGLE_OAUTH_VERIFICATION_STATUS: 'pilot_test_users',
      CONNECTOR_OAUTH_REDIRECT_URI: 'https://test.xlooop.com/settings/integrations',
      AI: { run: async () => ({ response: 'live' }) },
    } as never);
    const body = await res.json() as Record<string, any>;
    expect(body.checks.find((item: any) => item.id === 'connector_revocation')).toMatchObject({
      status: 'attention',
      details: {
        canary_ready: true,
        commercial_authorization_ready: false,
        oauth_verification_status: 'pilot_test_users',
      },
    });
  });

  it('keeps runtime and source failures visible instead of returning a false ready state', async () => {
    const currentDal = dal({
      listUserSources: vi.fn(async () => { throw new Error('source store unavailable'); }),
    });
    const res = await appFor(currentDal).request('/api/v1/settings/readiness', {}, {
      DATABASE_URL: 'postgres://redacted', SINGLE_INTAKE_ENABLED: 'false',
    } as never);
    const body = await res.json() as Record<string, any>;
    expect(body.status).toBe('unavailable');
    expect(body.checks.find((item: any) => item.id === 'effective_runtime').status).toBe('unavailable');
    expect(body.checks.find((item: any) => item.id === 'sources_freshness').status).toBe('unavailable');
    expect(body.checks.find((item: any) => item.id === 'api_gateway').status).toBe('attention');
    expect(body.checks.find((item: any) => item.id === 'connector_revocation').status).toBe('attention');
  });

  it('does not promote keyword-rich generic evidence to production lifecycle readiness', async () => {
    const currentDal = dal({
      listEvidenceItems: vi.fn(async () => [{
        id: 'evidence_spoof_attempt',
        workspace_id: 'workspace_a',
        packet_id: null,
        event_id: null,
        kind: 'receipt',
        title: 'Customer data delete export execution receipt',
        uri: 'xlooop://customer-data/delete-receipts/spoof',
        content_hash: 'a'.repeat(64),
        summary: 'Object retention legal hold negative read export delete all complete.',
        redaction_status: 'metadata_only',
        actor_user_id: 'user_a',
        created_at: '2026-08-09T00:00:00Z',
      }]),
    });
    const res = await appFor(currentDal).request('/api/v1/settings/readiness', {}, {
      DATABASE_URL: 'postgres://redacted',
      XLOOOP_RLS_APP_DATABASE_URL: 'postgres://redacted-app-role',
      XLOOOP_SCHEMA_HEAD: '93',
      SINGLE_INTAKE_ENABLED: 'true',
      AI: { run: async () => ({ response: 'live' }) },
    } as never);
    const body = await res.json() as Record<string, any>;
    const lifecycle = body.checks.find((item: any) => item.id === 'delete_export');
    expect(lifecycle).toMatchObject({
      status: 'attention',
      details: {
        bounded_evidence_count: 1,
        production_live_receipt_authority: 'unavailable',
        structured_receipt_verified: false,
      },
    });
    expect(lifecycle.receipt_refs).toEqual(['evidence_spoof_attempt']);
  });

  it('fails at the existing entitlement gate before exposing readiness', async () => {
    const currentDal = dal({ getSessionEntitlement: vi.fn(async () => ({ state: 'pending_access' })) });
    const res = await appFor(currentDal).request('/api/v1/settings/readiness', {}, { DATABASE_URL: 'x' } as never);
    expect(res.status).toBe(403);
  });
});
