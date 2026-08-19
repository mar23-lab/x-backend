import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
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

  it('promotes only a hash-pinned R2 production lifecycle receipt', async () => {
    const generatedAt = new Date().toISOString();
    const actionExecutedAt = new Date(Date.now() - 1_000).toISOString();
    const receipt = {
      schema_id: 'xlooop.delete_export_object_storage_receipt.v1',
      evidence_class: 'production_live_receipt',
      receipt_id: 'receipt.r2.lifecycle-live',
      immutable_receipt_ref: 'xlooop://receipts/cloudflare-r2/bucket/receipts/live/receipt.json',
      source_system: 'production_object_storage_lifecycle',
      tenant_scope: 'tenant_internal_validation',
      company_id: 'company_internal_validation',
      user_id: 'user_internal_validation',
      actor_id: 'actor_internal_validation',
      workspace_scope: 'workspace_internal_validation',
      approval_id: 'approval-live',
      export_request_id: 'export-live',
      delete_request_id: 'delete-live',
      audit_id: 'audit-live',
      storage_provider: 'cloudflare_r2',
      storage_bucket: 'receipts-live',
      object_key: 'validation/live/export.json',
      object_hash_sha256: 'a'.repeat(64),
      export_manifest_hash_sha256: 'b'.repeat(64),
      legal_hold_state: 'released_after_verified_delete_denial',
      legal_hold_policy_id: 'hold-live',
      retention_class: 'immutable_receipt_indefinite',
      rollback_boundary: 'deleted payload is irrecoverable',
      erasure_boundary: 'exact object key',
      tombstone_proof: 'r2_negative_read:proof-negative-read',
      negative_read_after_delete: true,
      raw_customer_data_used: false,
      action_executed_at: actionExecutedAt,
      generated_at: generatedAt,
      verifier_command: 'npm run verify:public-self-serve-production-receipts',
      receipt_proofs: {
        object_storage_receipt_id: 'proof-object',
        export_manifest_receipt_id: 'proof-manifest',
        proof_bundle_receipt_id: 'proof-bundle',
        delete_request_receipt_id: 'proof-delete',
        legal_hold_receipt_id: 'proof-hold',
        negative_read_receipt_id: 'proof-negative-read',
      },
    };
    const bytes = Buffer.from(JSON.stringify(receipt));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const res = await appFor(dal()).request('/api/v1/settings/readiness', {}, {
      DATABASE_URL: 'postgres://redacted',
      XLOOOP_RLS_APP_DATABASE_URL: 'postgres://redacted-app-role',
      XLOOOP_SCHEMA_HEAD: '102',
      SINGLE_INTAKE_ENABLED: 'true',
      AI: { run: async () => ({ response: 'live' }) },
      LIFECYCLE_RECEIPTS: { get: vi.fn(async () => ({ arrayBuffer: async () => bytes })) },
      DELETE_EXPORT_RECEIPT_KEY: 'receipts/live/receipt.json',
      DELETE_EXPORT_RECEIPT_SHA256: hash,
    } as never);
    const body = await res.json() as Record<string, any>;
    expect(body.checks.find((item: any) => item.id === 'delete_export')).toMatchObject({
      status: 'ready',
      details: {
        production_live_receipt_authority: 'verified',
        structured_receipt_verified: true,
        verification_failure: null,
      },
    });
  });

  it('fails closed when the pinned lifecycle receipt bytes drift', async () => {
    const bytes = Buffer.from('{"schema_id":"xlooop.delete_export_object_storage_receipt.v1"}');
    const res = await appFor(dal()).request('/api/v1/settings/readiness', {}, {
      DATABASE_URL: 'postgres://redacted',
      XLOOOP_SCHEMA_HEAD: '102',
      SINGLE_INTAKE_ENABLED: 'true',
      AI: { run: async () => ({ response: 'live' }) },
      LIFECYCLE_RECEIPTS: { get: vi.fn(async () => ({ arrayBuffer: async () => bytes })) },
      DELETE_EXPORT_RECEIPT_KEY: 'receipts/live/receipt.json',
      DELETE_EXPORT_RECEIPT_SHA256: 'f'.repeat(64),
    } as never);
    const body = await res.json() as Record<string, any>;
    expect(body.checks.find((item: any) => item.id === 'delete_export')).toMatchObject({
      status: 'attention',
      details: {
        production_live_receipt_authority: 'unavailable',
        structured_receipt_verified: false,
        verification_failure: 'pinned_receipt_hash_mismatch',
      },
    });
  });

  it('fails at the existing entitlement gate before exposing readiness', async () => {
    const currentDal = dal({ getSessionEntitlement: vi.fn(async () => ({ state: 'pending_access' })) });
    const res = await appFor(currentDal).request('/api/v1/settings/readiness', {}, { DATABASE_URL: 'x' } as never);
    expect(res.status).toBe(403);
  });
});
