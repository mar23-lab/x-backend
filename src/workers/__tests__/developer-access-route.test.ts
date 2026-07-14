// developer-access-route.test.ts · T2/P2 (260710) — the customer connector-token minter had ZERO route
// tests (flagged as the sharpest P2 hole: it mints write-capable tokens).
// DECLARED AXES: actor [human owner · human viewer · service principal] · flags [both off · read-only on ·
// operational on] · tenant binding [JWT workspace only] · audit [mint + revoke rows] · secret hygiene
// [raw token returned once, only SHA persisted].

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { developerAccessRoute } from '../routes/developer-access';

function appFor(auth: Record<string, unknown>, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', developerAccessRoute);
  return app;
}

function dalStub() {
  const audits: unknown[] = [];
  const created: Record<string, unknown>[] = [];
  return {
    audits, created,
    getSessionEntitlement: async () => ({ state: 'approved_workspace', workspace: { name: 'Acme' } }),
    createCustomerToken: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return { id: 'tok_1', role: input.role, label: input.label, expires_at: input.expires_at };
    }),
    listCustomerTokens: vi.fn(async () => [{ id: 'tok_1', role: 'viewer', label: 'x' }]),
    revokeCustomerToken: vi.fn(async (_ws: string, id: string) => ({ id, revoked_at: '2026-07-10T00:00:00Z' })),
    appendAuditLog: vi.fn(async (e: unknown) => { audits.push(e); }),
  };
}

const OWNER = { user_id: 'u_owner', workspace_id: 'org_acme', role: 'owner', auth_method: 'clerk_jwt', email: 'o@acme.test' };
const VIEWER = { user_id: 'u_view', workspace_id: 'org_acme', role: 'viewer', auth_method: 'clerk_jwt', email: 'v@acme.test' };
const SERVICE = { user_id: 'svc_1', workspace_id: 'org_acme', role: 'operator', auth_method: 'service_principal', service_principal: 'customer_token' };

const RO_ON = { DATABASE_URL: 'postgres://t', CUSTOMER_API_TOKENS_ENABLED: 'true' } as never;
const BOTH_ON = { DATABASE_URL: 'postgres://t', CUSTOMER_API_TOKENS_ENABLED: 'true', CUSTOMER_OPERATIONAL_TOKENS_ENABLED: 'true' } as never;
const OFF = { DATABASE_URL: 'postgres://t' } as never;

const mint = (app: Hono, body: Record<string, unknown>, env: never) =>
  app.request('/api/v1/developer-access/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);

describe('POST /developer-access/tokens · the controlled minter', () => {
  it('SERVICE PRINCIPAL can never mint (403 before any flag/authority check)', async () => {
    const dal = dalStub();
    const res = await mint(appFor(SERVICE, dal), {}, BOTH_ON);
    expect(res.status).toBe(403);
    expect(dal.createCustomerToken).not.toHaveBeenCalled();
  });

  it('viewer (human) → 403 via the governed-write gate (flag-off ≡ canWrite)', async () => {
    const dal = dalStub();
    const res = await mint(appFor(VIEWER, dal), {}, BOTH_ON);
    expect(res.status).toBe(403);
    expect(dal.createCustomerToken).not.toHaveBeenCalled();
  });

  it('owner but feature flags OFF → 409 (inert by default — the deploy-safety property)', async () => {
    const dal = dalStub();
    const res = await mint(appFor(OWNER, dal), {}, OFF);
    expect(res.status).toBe(409);
    expect(dal.createCustomerToken).not.toHaveBeenCalled();
  });

  it('owner + read-only flag → 201 viewer token; RAW shown once, only SHA persisted; JWT-workspace-bound; audited', async () => {
    const dal = dalStub();
    const res = await mint(appFor(OWNER, dal), { label: 'CI reader' }, RO_ON);
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(String(body.token)).toMatch(/^xlk_ro_[0-9a-f]{64}$/);
    const persisted = dal.created[0];
    expect(persisted.token_sha256).not.toBe(body.token);            // never the raw token in the DB
    expect(String(persisted.token_sha256)).toMatch(/^[0-9a-f]{64}$/); // SHA-256 only
    expect(persisted.workspace_id).toBe('org_acme');                 // tenant from JWT, not body
    expect(String(persisted.packet_prefix)).toContain('org-acme');   // packet scope is workspace-derived
    const audit = dal.audits[0] as Record<string, unknown>;
    expect(audit.action).toBe('customer_token_mint');
    expect(audit.target_type).toBe('api_token');
  });

  it('operator (write) token needs the SECOND flag: read-only-flag-only → 409; both flags → 201 xlk_op_', async () => {
    const dal = dalStub();
    expect((await mint(appFor(OWNER, dal), { role: 'operator' }, RO_ON)).status).toBe(409);
    const res = await mint(appFor(OWNER, dal), { role: 'operator' }, BOTH_ON);
    expect(res.status).toBe(201);
    expect(String(((await res.json()) as Record<string, unknown>).token)).toMatch(/^xlk_op_/);
  });
});

describe('GET/DELETE /developer-access/tokens · list + revoke', () => {
  it('viewer → 403 on list AND revoke; owner list is JWT-workspace-scoped', async () => {
    const dal = dalStub();
    expect((await appFor(VIEWER, dal).request('/api/v1/developer-access/tokens', {}, OFF)).status).toBe(403);
    expect((await appFor(VIEWER, dal).request('/api/v1/developer-access/tokens/tok_1', { method: 'DELETE' }, OFF)).status).toBe(403);
    const res = await appFor(OWNER, dal).request('/api/v1/developer-access/tokens', {}, OFF);
    expect(res.status).toBe(200);
    expect(dal.listCustomerTokens).toHaveBeenCalledWith('org_acme');
  });

  it('owner revoke → 200 + customer_token_revoke audit row', async () => {
    const dal = dalStub();
    const res = await appFor(OWNER, dal).request('/api/v1/developer-access/tokens/tok_9', { method: 'DELETE' }, OFF);
    expect(res.status).toBe(200);
    expect(dal.revokeCustomerToken).toHaveBeenCalledWith('org_acme', 'tok_9', 'u_owner');
    expect((dal.audits[0] as Record<string, unknown>).action).toBe('customer_token_revoke');
  });
});
