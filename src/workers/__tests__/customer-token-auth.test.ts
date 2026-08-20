import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  touchToken: vi.fn(async () => undefined),
}));

vi.mock('../db/client', () => ({ neonClient: vi.fn(() => vi.fn()) }));
vi.mock('../dal/customer-token-store', () => ({
  getCustomerTokenByHashRow: mocks.getToken,
  touchCustomerTokenRow: mocks.touchToken,
}));

import { clerkAuth } from '../middleware/auth';

const baseRow = {
  id: 'cat_1',
  workspace_id: 'ws_a',
  role: 'viewer',
  label: 'test',
  packet_prefix: 'pkt-ws-a-',
  scopes: ['read:session', 'read:packets'],
  authority_mode: 'delegated_user',
  issuer_membership_activated_at: '2026-08-10T00:00:00.000Z',
  issuer_membership_active: true,
  created_by: 'user_authorizer',
  created_at: '2026-08-10T00:00:00.000Z',
  expires_at: '2099-01-01T00:00:00.000Z',
  revoked_at: null,
  revoked_by: null,
  last_used_at: null,
};

function app() {
  const api = new Hono();
  api.use('*', clerkAuth({ allowCustomerToken: true }));
  api.get('/api/v1/mcp/session-start', (ctx) => ctx.json(ctx.get('auth')));
  api.get('/api/v1/packets/:id', (ctx) => ctx.json(ctx.get('auth')));
  api.post('/api/v1/evidence', (ctx) => ctx.json(ctx.get('auth')));
  api.post('/api/v1/customer-data/delete-requests', (ctx) => ctx.json(ctx.get('auth')));
  return api;
}

const env = {
  CLERK_SECRET_KEY: 'unused',
  DATABASE_URL: 'postgres://unused',
  CUSTOMER_API_TOKENS_ENABLED: 'true',
};
const headers = { Authorization: 'Bearer xlk_ro_test' };

describe('customer connector authentication authority and scopes', () => {
  beforeEach(() => {
    mocks.getToken.mockReset();
    mocks.getToken.mockResolvedValue({ ...baseRow });
  });

  it('hydrates only the persisted connector scopes and delegation lineage', async () => {
    const response = await app().request('/api/v1/mcp/session-start', { headers }, env);
    expect(response.status).toBe(200);
    const auth = await response.json() as Record<string, unknown>;
    expect(auth.connector_scopes).toEqual(['read:session', 'read:packets']);
    expect(auth.delegated_by_user_id).toBe('user_authorizer');
  });

  it('revokes effective access when the authorizing membership is no longer active', async () => {
    mocks.getToken.mockResolvedValue({ ...baseRow, issuer_membership_active: false });
    const response = await app().request('/api/v1/mcp/session-start', { headers }, env);
    expect(response.status).toBe(401);
    expect((await response.json() as { code: string }).code).toBe('AUTHORITY_REVOKED');
  });

  it('reports a revoked opaque connector credential without misclassifying it as a JWT', async () => {
    mocks.getToken.mockResolvedValue(null);
    const revokedHeaders = { Authorization: `Bearer xlk_ro_${'a'.repeat(64)}` };
    const response = await app().request('/api/v1/mcp/session-start', { headers: revokedHeaders }, env);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: 'UNAUTHORIZED',
      error: 'customer connector token is invalid or revoked',
    });
  });

  it('denies missing scopes and every unregistered customer-token operation', async () => {
    const write = await app().request('/api/v1/evidence', { method: 'POST', headers }, env);
    expect(write.status).toBe(403);

    const lifecycle = await app().request('/api/v1/customer-data/delete-requests', { method: 'POST', headers }, env);
    expect(lifecycle.status).toBe(403);
  });
});
