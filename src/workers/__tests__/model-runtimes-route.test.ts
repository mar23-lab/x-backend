// model-runtimes-route.test.ts · Wave C · the /api/v1/model-runtimes route contract. Injects auth + a fake
// dal.modelRuntimes facade + real encryption material, and asserts: masked reads (no ciphertext/plaintext
// ever in a response), owner/operator write-gating (viewer/client 403), provider + credential validation
// (400/422/503), the audited default flip path, and the self-scoped override. Uses the REAL crypto lib so
// the encrypt-on-write path is exercised end-to-end.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { modelRuntimesRoute } from '../routes/model-runtimes';
import { credentialEnvelopeKeyId, decryptCredential, encryptCredential } from '../lib/model-runtime-crypto';

const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)));
const KEY_2 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff)));
const RAW_API_KEY = 'sk-ant-FIXTURE-PLAINTEXT-not-a-real-key-wxyz'; // fixture — synthetic, not a real Anthropic key

const maskedRow = (over: Record<string, any> = {}) => ({
  id: 'mrp_1', provider: 'anthropic', auth_kind: 'api_key', base_url: null, model: null,
  credential_last4: 'wxyz', enabled: true, is_default: false, created_by: 'u1',
  created_at: '2026-07-08T00:00:00Z', updated_at: '2026-07-08T00:00:00Z', ...over,
});
const providerReceipt = (over: Record<string, any> = {}) => ({
  provider: maskedRow(over.provider || {}),
  provider_config_version_id: over.provider_config_version_id || 'model-runtime-provider:mrp_1:2026-07-08T00:00:00Z',
  audit_event_id: over.audit_event_id || 'audit_1',
});
const defaultReceipt = (over: Record<string, any> = {}) => ({
  provider: maskedRow({ is_default: true, ...(over.provider || {}) }),
  default_revision_id: over.default_revision_id || 'model-runtime-default:mrp_1:2026-07-08T00:00:00Z',
  audit_event_id: over.audit_event_id || 'audit_default_1',
});
const deleteReceipt = (over: Record<string, any> = {}) => ({
  provider: over.provider || 'anthropic',
  deleted_provider_config_id: over.deleted_provider_config_id || 'mrp_1',
  provider_config_version_id: over.provider_config_version_id || 'model-runtime-provider:mrp_1:deleted:audit_delete_1',
  audit_event_id: over.audit_event_id || 'audit_delete_1',
});

function makeDal(over: Record<string, any> = {}) {
  return {
    appendAuditLog: vi.fn(async () => undefined),
    modelRuntimes: {
      listProviders: vi.fn(async () => [] as any[]),
      getOverride: vi.fn(async () => null),
      getProviderCredential: vi.fn(async () => null),
      upsertProvider: vi.fn(async () => providerReceipt()),
      rotateProviderCredential: vi.fn(async () => ({
        provider: 'anthropic',
        provider_config_id: 'mrp_1',
        provider_config_version_id: 'model-runtime-provider:mrp_1:2026-08-09T00:00:00Z',
        credential_rotation_receipt_id: 'model-runtime-credential-rotation:mrp_1:audit_rotate_1',
        audit_event_id: 'audit_rotate_1',
      })),
      deleteProvider: vi.fn(async () => deleteReceipt()),
      setDefaultProvider: vi.fn(async () => defaultReceipt()),
      setOverride: vi.fn(async (_u: string, _w: string, id: string) => id),
      clearOverride: vi.fn(async () => undefined),
      ...over,
    },
  };
}

function appFor(dal: any, auth: { user_id: string; workspace_id: string; role: string } = { user_id: 'u1', workspace_id: 'org_a', role: 'operator' }) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', modelRuntimesRoute);
  return app;
}
const ENV = {
  MODEL_RUNTIME_ENC_KEYS: JSON.stringify({ 'tenant-v1': KEY }),
  MODEL_RUNTIME_ACTIVE_KEY_ID: 'tenant-v1',
} as never;
const call = (app: Hono, path: string, method: string, body?: unknown) =>
  app.request('/api/v1' + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } }, ENV);

afterEach(() => vi.restoreAllMocks());

describe('GET /model-runtimes/providers', () => {
  it('200 — returns the 13-provider masked catalog + default + override; NEVER any ciphertext/plaintext', async () => {
    const dal = makeDal({ listProviders: vi.fn(async () => [maskedRow({ is_default: true })]), getOverride: vi.fn(async () => 'mrp_1') });
    const res = await call(appFor(dal), '/model-runtimes/providers', 'GET');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toHaveLength(13);
    expect(body.workspace_default).toBe('mrp_1');
    expect(body.session_override).toBe('mrp_1');
    const configured = body.providers.find((p: any) => p.id === 'mrp_1');
    expect(configured.masked_key).toBe('····wxyz'); // masked only
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/credential_ciphertext|credential_iv/);
    // M4 · server-derived authority envelope (not a bare boolean). An operator sees the write actions.
    expect(body.allowed_actions).toEqual(expect.arrayContaining(['read', 'set', 'delete', 'set_default', 'set_override']));
    expect(body.disabled_reasons).toEqual({});
    expect(body.manageable).toBeUndefined(); // the bare-boolean hint is gone; allowed_actions is the contract
  });

  it('M4 — a viewer GET gets read/set_override allowed but the writes DISABLED with reasons', async () => {
    const res = await call(appFor(makeDal(), { user_id: 'v', workspace_id: 'org_a', role: 'viewer' }), '/model-runtimes/providers', 'GET');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed_actions).toEqual(expect.arrayContaining(['read', 'set_override']));
    expect(body.allowed_actions).not.toContain('set');
    expect(body.disabled_reasons.set).toMatch(/owner or operator/);
    expect(body.disabled_reasons.set_default).toBeTruthy();
  });

  it('403 — a client role cannot read model-runtime config', async () => {
    const res = await call(appFor(makeDal(), { user_id: 'c', workspace_id: 'org_a', role: 'client' }), '/model-runtimes/providers', 'GET');
    expect(res.status).toBe(403);
  });

  it('401 — no auth', async () => {
    const res = await call(appFor(makeDal(), { user_id: '', workspace_id: 'org_a', role: 'operator' }), '/model-runtimes/providers', 'GET');
    expect(res.status).toBe(401);
  });
});

describe('effective runtime + live provider operations', () => {
  it('GET effective reports the runtime customer chat will actually use', async () => {
    const res = await appFor(makeDal()).request('/api/v1/model-runtimes/effective', { method: 'GET' }, {
      MODEL_RUNTIME_ENC_KEY: KEY,
      AI: { run: async () => ({ response: 'live' }) },
    } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      effective: { runtime_id: 'platform:workers_ai', provider: 'workers_ai', source: 'platform_default' },
      fallback_count: 0,
      policy_enforcement: {
        status: 'enforced',
        authority: 'xlooop_backend',
        policy_version: 'commercial_live_v1',
        mutable: false,
      },
    });
  });

  it('GET models uses the stored tenant credential and never returns it', async () => {
    const sealed = await encryptCredential(KEY, JSON.stringify({ api_key: RAW_API_KEY }));
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['x-api-key']).toBe(RAW_API_KEY);
      return new Response(JSON.stringify({ data: [{ id: 'claude-live' }, { id: 'claude-other' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const dal = makeDal({
      listProviders: vi.fn(async () => [maskedRow({ model: 'claude-live' })]),
      getProviderCredential: vi.fn(async () => sealed),
    });
    const res = await call(appFor(dal), '/model-runtimes/providers/anthropic/models', 'GET');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      provider: 'anthropic',
      models: expect.arrayContaining(['claude-live', 'claude-other']),
    });
    expect(dal.modelRuntimes.getProviderCredential).toHaveBeenCalledWith('org_a', 'anthropic');
    expect(JSON.stringify(body)).not.toContain(RAW_API_KEY);
  });

  it('GET models returns typed relay-required for a customer-side runtime', async () => {
    const dal = makeDal({
      listProviders: vi.fn(async () => [maskedRow({ provider: 'ollama', model: 'llama-live', base_url: 'http://localhost:11434' })]),
    });
    const res = await call(appFor(dal), '/model-runtimes/providers/ollama/models', 'GET');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'RELAY_REQUIRED' });
  });

  it('POST validate uses the stored tenant credential and returns a redacted audit receipt', async () => {
    const sealed = await encryptCredential(KEY, JSON.stringify({ api_key: RAW_API_KEY }));
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['x-api-key']).toBe(RAW_API_KEY);
      return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Xlooop runtime ready.' }],
      usage: { input_tokens: 9, output_tokens: 4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const dal = makeDal({
      listProviders: vi.fn(async () => [maskedRow({ model: 'claude-live' })]),
      getProviderCredential: vi.fn(async () => sealed),
    });
    const res = await appFor(dal).request('/api/v1/model-runtimes/providers/anthropic/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, { MODEL_RUNTIME_ENC_KEY: KEY, ANTHROPIC_API_KEY: 'platform-key' } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      audit_recorded: true,
      provider: 'anthropic',
      model: 'claude-live',
      usage: { tokens_in: 9, tokens_out: 4 },
    });
    expect(body.validation_receipt_id).toMatch(/^mrv_/);
    expect(dal.appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'model_runtime_validate',
      target_type: 'model_runtime_provider',
      workspace_id: 'org_a',
    }));
    expect(dal.modelRuntimes.getProviderCredential).toHaveBeenCalledWith('org_a', 'anthropic');
    expect(JSON.stringify(body)).not.toContain(RAW_API_KEY);
  });
});

describe('PUT /model-runtimes/providers/:provider — encrypt-on-write', () => {
  it('200 — operator sets a key; dal gets a SEALED credential (not plaintext); response leaks nothing', async () => {
    const dal = makeDal();
    const res = await call(appFor(dal), '/model-runtimes/providers/anthropic', 'PUT', { credential: { api_key: RAW_API_KEY } });
    expect(res.status).toBe(200);
    // dal received a sealed credential — ciphertext is base64, NOT the plaintext; last4 is the key tail
    const arg = dal.modelRuntimes.upsertProvider.mock.calls[0][2];
    expect(arg.sealed.ciphertext).toBeTruthy();
    expect(arg.sealed.ciphertext).not.toContain('PLAINTEXT');
    expect(JSON.stringify(arg.sealed)).not.toContain(RAW_API_KEY);
    expect(arg.sealed.last4).toBe('wxyz');
    // the response body contains neither the plaintext nor the ciphertext
    const text = await res.text();
    expect(text).not.toContain(RAW_API_KEY);
    expect(text).not.toContain(arg.sealed.ciphertext);
    const body = JSON.parse(text);
    expect(body.provider_config_version_id).toMatch(/^model-runtime-provider:/);
    expect(body.audit_event_id).toBe('audit_1');
  });

  it('500 — provider write without an audit receipt fails closed', async () => {
    const dal = makeDal({ upsertProvider: vi.fn(async () => ({ provider: maskedRow(), provider_config_version_id: '', audit_event_id: '' })) });
    const res = await call(appFor(dal), '/model-runtimes/providers/anthropic', 'PUT', { credential: { api_key: RAW_API_KEY } });
    expect(res.status).toBe(500);
  });

  it('403 — a viewer cannot configure (owner/operator only)', async () => {
    const dal = makeDal();
    const res = await call(appFor(dal, { user_id: 'v', workspace_id: 'org_a', role: 'viewer' }), '/model-runtimes/providers/anthropic', 'PUT', { credential: { api_key: RAW_API_KEY } });
    expect(res.status).toBe(403);
    expect(dal.modelRuntimes.upsertProvider).not.toHaveBeenCalled();
  });

  it('400 — an unknown provider is rejected before any DB/crypto work', async () => {
    const dal = makeDal();
    const res = await call(appFor(dal), '/model-runtimes/providers/not_a_provider', 'PUT', { credential: { api_key: RAW_API_KEY } });
    expect(res.status).toBe(400);
    expect(dal.modelRuntimes.upsertProvider).not.toHaveBeenCalled();
  });

  it('422 — a keyless-local provider rejects a credential', async () => {
    const res = await call(appFor(makeDal()), '/model-runtimes/providers/ollama', 'PUT', { base_url: 'http://localhost:11434', credential: { api_key: 'x' } });
    expect(res.status).toBe(422);
  });

  it('422 — a local provider without base_url is rejected', async () => {
    const res = await call(appFor(makeDal()), '/model-runtimes/providers/ollama', 'PUT', {});
    expect(res.status).toBe(422);
  });

  it('422 — a cloud provider cannot configure an arbitrary base_url', async () => {
    const res = await call(appFor(makeDal()), '/model-runtimes/providers/anthropic', 'PUT', {
      base_url: 'http://127.0.0.1:8787', credential: { api_key: RAW_API_KEY },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'UNPROCESSABLE' });
  });

  it('422 — a cloud provider created with no credential is rejected', async () => {
    const dal = makeDal({ getProviderCredential: vi.fn(async () => null) }); // no existing key
    const res = await call(appFor(dal), '/model-runtimes/providers/openai', 'PUT', { model: 'gpt-x' });
    expect(res.status).toBe(422);
  });

  it('200 — keyless-local provider configures with just a base_url (no credential)', async () => {
    const dal = makeDal({ upsertProvider: vi.fn(async () => providerReceipt({ provider: { provider: 'ollama', auth_kind: 'none', base_url: 'http://localhost:11434', credential_last4: null } })) });
    const res = await call(appFor(dal), '/model-runtimes/providers/ollama', 'PUT', { base_url: 'http://localhost:11434' });
    expect(res.status).toBe(200);
    expect((await res.json()).provider.masked_key).toBeNull();
  });

  it('503 — a credential write is refused when the versioned keyring is unset (never stores plaintext)', async () => {
    const dal = makeDal();
    const app = appFor(dal);
    const res = await app.request('/api/v1/model-runtimes/providers/anthropic', {
      method: 'PUT', body: JSON.stringify({ credential: { api_key: RAW_API_KEY } }), headers: { 'content-type': 'application/json' },
    }, {} as never); // env WITHOUT the key
    expect(res.status).toBe(503);
    expect(dal.modelRuntimes.upsertProvider).not.toHaveBeenCalled();
  });
});

describe('POST /model-runtimes/providers/:provider/rotate-credential', () => {
  it('re-encrypts a tenant credential under the active key and returns only audited metadata', async () => {
    const oldConfig = { active_key_id: 'tenant-v1', keys: { 'tenant-v1': KEY } };
    const rotationConfig = { active_key_id: 'tenant-v2', keys: { 'tenant-v1': KEY, 'tenant-v2': KEY_2 } };
    const oldSealed = await encryptCredential(oldConfig, JSON.stringify({ api_key: RAW_API_KEY }));
    const dal = makeDal({ getProviderCredential: vi.fn(async () => oldSealed) });
    const response = await appFor(dal).request(
      '/api/v1/model-runtimes/providers/anthropic/rotate-credential',
      { method: 'POST' },
      {
        MODEL_RUNTIME_ENC_KEYS: JSON.stringify(rotationConfig.keys),
        MODEL_RUNTIME_ACTIVE_KEY_ID: rotationConfig.active_key_id,
      } as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      provider: 'anthropic',
      from_key_id: 'tenant-v1',
      to_key_id: 'tenant-v2',
      credential_rotation_receipt_id: 'model-runtime-credential-rotation:mrp_1:audit_rotate_1',
      audit_event_id: 'audit_rotate_1',
    });
    const rotated = dal.modelRuntimes.rotateProviderCredential.mock.calls[0][2];
    expect(credentialEnvelopeKeyId(rotated)).toBe('tenant-v2');
    expect(await decryptCredential(rotationConfig, rotated, { tenant_id: 'org_a', purpose: 'anthropic' }))
      .toBe(JSON.stringify({ api_key: RAW_API_KEY }));
    expect(JSON.stringify(body)).not.toContain(RAW_API_KEY);
    expect(JSON.stringify(body)).not.toContain(rotated.ciphertext);
  });

  it('returns 409 and performs no write when the credential already uses the active key', async () => {
    const config = { active_key_id: 'tenant-v2', keys: { 'tenant-v2': KEY_2 } };
    const sealed = await encryptCredential(
      config,
      JSON.stringify({ api_key: RAW_API_KEY }),
      { tenant_id: 'org_a', purpose: 'anthropic' },
    );
    const dal = makeDal({ getProviderCredential: vi.fn(async () => sealed) });
    const response = await appFor(dal).request(
      '/api/v1/model-runtimes/providers/anthropic/rotate-credential',
      { method: 'POST' },
      { MODEL_RUNTIME_ENC_KEYS: JSON.stringify(config.keys), MODEL_RUNTIME_ACTIVE_KEY_ID: config.active_key_id } as never,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CREDENTIAL_ALREADY_ACTIVE' });
    expect(dal.modelRuntimes.rotateProviderCredential).not.toHaveBeenCalled();
  });

  it('fails closed when only the legacy single encryption key is configured', async () => {
    const dal = makeDal({ getProviderCredential: vi.fn(async () => null) });
    const response = await appFor(dal).request(
      '/api/v1/model-runtimes/providers/anthropic/rotate-credential',
      { method: 'POST' },
      { MODEL_RUNTIME_ENC_KEY: KEY } as never,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(dal.modelRuntimes.getProviderCredential).not.toHaveBeenCalled();
  });
});

describe('PUT /model-runtimes/default — audited flip', () => {
  it('200 — validates the provider is in the workspace, then flips (dal.setDefaultProvider called)', async () => {
    const dal = makeDal({ listProviders: vi.fn(async () => [maskedRow({ id: 'mrp_1' })]) });
    const res = await call(appFor(dal), '/model-runtimes/default', 'PUT', { provider_id: 'mrp_1' });
    expect(res.status).toBe(200);
    expect(dal.modelRuntimes.setDefaultProvider).toHaveBeenCalledWith('org_a', 'mrp_1', 'u1');
    const body = await res.json();
    expect(body.default_revision_id).toMatch(/^model-runtime-default:/);
    expect(body.audit_event_id).toBe('audit_default_1');
  });

  it('500 — default write without an audit receipt fails closed', async () => {
    const dal = makeDal({
      listProviders: vi.fn(async () => [maskedRow({ id: 'mrp_1' })]),
      setDefaultProvider: vi.fn(async () => ({ provider: maskedRow({ is_default: true }), default_revision_id: '', audit_event_id: '' })),
    });
    const res = await call(appFor(dal), '/model-runtimes/default', 'PUT', { provider_id: 'mrp_1' });
    expect(res.status).toBe(500);
  });

  it('404 — a provider_id not configured in this workspace is rejected (no flip)', async () => {
    const dal = makeDal({ listProviders: vi.fn(async () => [maskedRow({ id: 'mrp_other' })]) });
    const res = await call(appFor(dal), '/model-runtimes/default', 'PUT', { provider_id: 'mrp_ghost' });
    expect(res.status).toBe(404);
    expect(dal.modelRuntimes.setDefaultProvider).not.toHaveBeenCalled();
  });

  it('403 — a viewer cannot flip the default', async () => {
    const res = await call(appFor(makeDal(), { user_id: 'v', workspace_id: 'org_a', role: 'viewer' }), '/model-runtimes/default', 'PUT', { provider_id: 'mrp_1' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE + override', () => {
  it('DELETE 404 when nothing was removed', async () => {
    const dal = makeDal({ deleteProvider: vi.fn(async () => null) });
    const res = await call(appFor(dal), '/model-runtimes/providers/anthropic', 'DELETE');
    expect(res.status).toBe(404);
  });

  it('DELETE 200 requires provider config and audit receipt ids', async () => {
    const res = await call(appFor(makeDal()), '/model-runtimes/providers/anthropic', 'DELETE');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted_provider_config_id).toBe('mrp_1');
    expect(body.provider_config_version_id).toMatch(/^model-runtime-provider:/);
    expect(body.audit_event_id).toBe('audit_delete_1');
  });

  it('DELETE 500 when the DAL omits the audit receipt', async () => {
    const dal = makeDal({ deleteProvider: vi.fn(async () => ({ provider: 'anthropic', deleted_provider_config_id: 'mrp_1', provider_config_version_id: '', audit_event_id: '' })) });
    const res = await call(appFor(dal), '/model-runtimes/providers/anthropic', 'DELETE');
    expect(res.status).toBe(500);
  });

  it('PUT override — self-scoped; 404 when the provider is not in the workspace', async () => {
    const okDal = makeDal({ listProviders: vi.fn(async () => [maskedRow({ id: 'mrp_1' })]) });
    const ok = await call(appFor(okDal), '/model-runtimes/override', 'PUT', { provider_id: 'mrp_1' });
    expect(ok.status).toBe(200);
    expect(okDal.modelRuntimes.setOverride).toHaveBeenCalledWith('u1', 'org_a', 'mrp_1');
    const ghost = await call(appFor(makeDal({ listProviders: vi.fn(async () => []) })), '/model-runtimes/override', 'PUT', { provider_id: 'mrp_x' });
    expect(ghost.status).toBe(404);
  });

  it('PUT override — a client cannot set an override', async () => {
    const res = await call(appFor(makeDal(), { user_id: 'c', workspace_id: 'org_a', role: 'client' }), '/model-runtimes/override', 'PUT', { provider_id: 'mrp_1' });
    expect(res.status).toBe(403);
  });

  it('PUT override clearOverride returns the caller to the workspace default', async () => {
    const dal = makeDal();
    const res = await call(appFor(dal), '/model-runtimes/override', 'PUT', { clear_override: true });
    expect(res.status).toBe(200);
    expect(dal.modelRuntimes.clearOverride).toHaveBeenCalledWith('u1', 'org_a');
    expect(await res.json()).toMatchObject({ session_override: null, effective_source: 'workspace_default' });
  });
});
