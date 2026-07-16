// model-runtimes-route.test.ts · Wave C · the /api/v1/model-runtimes route contract. Injects auth + a fake
// dal.modelRuntimes facade + a real MODEL_RUNTIME_ENC_KEY, and asserts: masked reads (no ciphertext/plaintext
// ever in a response), owner/operator write-gating (viewer/client 403), provider + credential validation
// (400/422/503), the audited default flip path, and the self-scoped override. Uses the REAL crypto lib so
// the encrypt-on-write path is exercised end-to-end.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { modelRuntimesRoute } from '../routes/model-runtimes';

const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)));
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
    modelRuntimes: {
      listProviders: vi.fn(async () => [] as any[]),
      getOverride: vi.fn(async () => null),
      getProviderCredential: vi.fn(async () => null),
      upsertProvider: vi.fn(async () => providerReceipt()),
      deleteProvider: vi.fn(async () => deleteReceipt()),
      setDefaultProvider: vi.fn(async () => defaultReceipt()),
      setOverride: vi.fn(async (_u: string, _w: string, id: string) => id),
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
const ENV = { MODEL_RUNTIME_ENC_KEY: KEY } as never;
const call = (app: Hono, path: string, method: string, body?: unknown) =>
  app.request('/api/v1' + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } }, ENV);

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

  it('503 — a credential write is refused when MODEL_RUNTIME_ENC_KEY is unset (never stores plaintext)', async () => {
    const dal = makeDal();
    const app = appFor(dal);
    const res = await app.request('/api/v1/model-runtimes/providers/anthropic', {
      method: 'PUT', body: JSON.stringify({ credential: { api_key: RAW_API_KEY } }), headers: { 'content-type': 'application/json' },
    }, {} as never); // env WITHOUT the key
    expect(res.status).toBe(503);
    expect(dal.modelRuntimes.upsertProvider).not.toHaveBeenCalled();
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
});
