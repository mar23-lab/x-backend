// customer.test.ts - R55 Phase 4b - POST /customer/authority-consent + POST /customer/invites
//
// Covers the customer-side IP-boundary authority/consent acknowledgement (typed-name, DR-12)
// and the authority-gated Clerk org teammate invite. Auth + DAL are injected via test middleware;
// createTeamInvitation (Clerk) is mocked so the tests have no network / Clerk dependency.
//
// Authority: src/workers/routes/customer.ts + CUSTOMER_ECOSYSTEM_ONBOARDING_AND_IP_BOUNDARY_STANDARD

import { describe, it, expect, vi } from 'vitest';

// Mock the Clerk org wrapper BEFORE importing the route under test.
vi.mock('../services/clerk-org', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createTeamInvitation: vi.fn(async (_secretKey: string, input: { emailAddress: string; role: string }) => ({
      invitation_id: 'inv_test_123',
      email: input.emailAddress,
      role: input.role,
      status: 'pending',
    })),
  };
});

import { Hono } from 'hono';
import { customerRoute } from '../routes/customer';

const ENV = { CLERK_SECRET_KEY: 'sk_test_x', DATABASE_URL: 'postgres://test' };

function authorityState(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: 'org_acme',
    unlocked: false,
    operator_approved: false,
    consent_acked: false,
    allowed_modes: [],
    allowed_apps: [],
    consent: null,
    ...overrides,
  };
}

function appFor(auth: Record<string, unknown>, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', customerRoute);
  return app;
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(
    `/api/v1${path}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ENV as never
  );
}

describe('POST /customer/authority-consent', () => {
  it('401 when unauthenticated', async () => {
    const res = await post(appFor({}, {}), '/customer/authority-consent', { full_name_typed: 'Jane Smith' });
    expect(res.status).toBe(401);
  });

  it('400 when no workspace (org) scope', async () => {
    const res = await post(
      appFor({ user_id: 'u1' }, {}),
      '/customer/authority-consent',
      { full_name_typed: 'Jane Smith' }
    );
    expect(res.status).toBe(400);
  });

  it('400 when full_name_typed too short (and consent is NOT recorded)', async () => {
    const recordCustomerConsentAck = vi.fn();
    const res = await post(
      appFor({ user_id: 'u1', workspace_id: 'org_acme' }, { recordCustomerConsentAck }),
      '/customer/authority-consent',
      { full_name_typed: 'J' }
    );
    expect(res.status).toBe(400);
    expect(recordCustomerConsentAck).not.toHaveBeenCalled();
  });

  it('202 records consent; awaiting-operator message when operator side absent', async () => {
    const recordCustomerConsentAck = vi.fn(async () => ({ id: 'cac1' }));
    const getCustomerAuthorityState = vi.fn(async () =>
      authorityState({ consent_acked: true, operator_approved: false, unlocked: false })
    );
    const res = await post(
      appFor(
        { user_id: 'u1', workspace_id: 'org_acme', email: 'j@acme.com' },
        { recordCustomerConsentAck, getCustomerAuthorityState }
      ),
      '/customer/authority-consent',
      { full_name_typed: 'Jane Smith', scopes_confirmed: { watch_mode: true } }
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as Record<string, any>;
    expect(json.acknowledged).toBe(true);
    expect(json.authority.unlocked).toBe(false);
    expect(json.message).toMatch(/awaiting operator/i);
    expect(recordCustomerConsentAck).toHaveBeenCalledOnce();
    const arg = recordCustomerConsentAck.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.full_name_typed).toBe('Jane Smith');
    expect(arg.workspace_id).toBe('org_acme');
    expect(arg.user_id).toBe('u1');
  });

  it('202 unlocked message when both authority sides are present', async () => {
    const res = await post(
      appFor(
        { user_id: 'u1', workspace_id: 'org_acme' },
        {
          recordCustomerConsentAck: vi.fn(async () => ({ id: 'cac1' })),
          getCustomerAuthorityState: vi.fn(async () =>
            authorityState({ consent_acked: true, operator_approved: true, unlocked: true })
          ),
        }
      ),
      '/customer/authority-consent',
      { full_name_typed: 'Jane Smith' }
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as Record<string, any>;
    expect(json.authority.unlocked).toBe(true);
    expect(json.message).toMatch(/unlocked/i);
  });

  it('W1b: auto-records operator approval for the operator OWN org + captures identity bundle', async () => {
    let unlocked = false;
    const recordCustomerConsentAck = vi.fn(async () => ({ id: 'cac1' }));
    const recordOperatorAuthority = vi.fn(async () => { unlocked = true; return { id: 'cac1' }; });
    const getCustomerAuthorityState = vi.fn(async () =>
      authorityState({ workspace_id: 'org_mine', consent_acked: true, operator_approved: unlocked, unlocked })
    );
    const app = appFor(
      { user_id: 'user_op', workspace_id: 'org_mine', email: 'op@xlooop.com' },
      { recordCustomerConsentAck, recordOperatorAuthority, getCustomerAuthorityState }
    );
    const res = await app.request(
      '/api/v1/customer/authority-consent',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name_typed: 'Op Erator', company: 'Xlooop' }) },
      { CLERK_SECRET_KEY: 'sk_test_x', DATABASE_URL: 'x', MBP_OWNER_USER_ID: 'user_op' } as never
    );
    expect(res.status).toBe(202);
    expect(recordOperatorAuthority).toHaveBeenCalledOnce();
    expect(recordOperatorAuthority.mock.calls[0][0]).toMatchObject({ workspace_id: 'org_mine', operator_user_id: 'user_op' });
    const ackArg = recordCustomerConsentAck.mock.calls[0][0] as Record<string, unknown>;
    expect(ackArg.email).toBe('op@xlooop.com');
    expect(ackArg.company).toBe('Xlooop');
    const json = (await res.json()) as Record<string, any>;
    expect(json.authority.unlocked).toBe(true);
  });

  it('W1b: does NOT auto-approve a CUSTOMER org (consenter is not the operator)', async () => {
    const recordOperatorAuthority = vi.fn();
    const app = appFor(
      { user_id: 'user_customer', workspace_id: 'org_cust', email: 'c@cust.com' },
      {
        recordCustomerConsentAck: vi.fn(async () => ({ id: 'cac1' })),
        recordOperatorAuthority,
        getCustomerAuthorityState: vi.fn(async () =>
          authorityState({ workspace_id: 'org_cust', consent_acked: true, operator_approved: false, unlocked: false })
        ),
      }
    );
    const res = await app.request(
      '/api/v1/customer/authority-consent',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name_typed: 'Cust Omer' }) },
      { CLERK_SECRET_KEY: 'sk_test_x', DATABASE_URL: 'x', MBP_OWNER_USER_ID: 'user_op' } as never
    );
    expect(res.status).toBe(202);
    expect(recordOperatorAuthority).not.toHaveBeenCalled();
  });

  it('W4: auto-approves an org in OPERATOR_WORKSPACE_IDS (allowlist is org-keyed, not consenter-keyed)', async () => {
    const recordOperatorAuthority = vi.fn(async () => ({ id: 'cac1' }));
    const app = appFor(
      { user_id: 'user_anyone', workspace_id: 'org_mine', email: 'x@x.com' }, // consenter is NOT the operator
      {
        recordCustomerConsentAck: vi.fn(async () => ({ id: 'cac1' })),
        recordOperatorAuthority,
        getCustomerAuthorityState: vi.fn(async () =>
          authorityState({ workspace_id: 'org_mine', consent_acked: true, operator_approved: true, unlocked: true })
        ),
      }
    );
    const res = await app.request(
      '/api/v1/customer/authority-consent',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name_typed: 'A Person' }) },
      { CLERK_SECRET_KEY: 'sk_test_x', DATABASE_URL: 'x', OPERATOR_WORKSPACE_IDS: 'org_mine,org_other' } as never
    );
    expect(res.status).toBe(202);
    expect(recordOperatorAuthority).toHaveBeenCalledOnce(); // org in allowlist → auto-approve regardless of who consented
  });

  it('W4: allowlist OVERRIDES the heuristic — an org NOT in OPERATOR_WORKSPACE_IDS is not auto-approved even if the consenter is the operator', async () => {
    const recordOperatorAuthority = vi.fn();
    const app = appFor(
      { user_id: 'user_op', workspace_id: 'org_customer', email: 'x@x.com' }, // consenter IS the operator…
      {
        recordCustomerConsentAck: vi.fn(async () => ({ id: 'cac1' })),
        recordOperatorAuthority,
        getCustomerAuthorityState: vi.fn(async () =>
          authorityState({ workspace_id: 'org_customer', consent_acked: true, operator_approved: false, unlocked: false })
        ),
      }
    );
    const res = await app.request(
      '/api/v1/customer/authority-consent',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name_typed: 'Op Erator' }) },
      { CLERK_SECRET_KEY: 'sk_test_x', DATABASE_URL: 'x', MBP_OWNER_USER_ID: 'user_op', OPERATOR_WORKSPACE_IDS: 'org_mine' } as never
    );
    expect(res.status).toBe(202);
    // …but org_customer is NOT in the allowlist, so the precise allowlist path blocks auto-approval.
    expect(recordOperatorAuthority).not.toHaveBeenCalled();
  });
});

describe('GET /customer/authority-consent', () => {
  function get(app: Hono, path: string, env: Record<string, unknown> = ENV as never) {
    return app.request(`/api/v1${path}`, { method: 'GET' }, env as never);
  }

  it('401 when unauthenticated', async () => {
    const res = await get(appFor({}, {}), '/customer/authority-consent');
    expect(res.status).toBe(401);
  });

  it('400 when no workspace (org) scope', async () => {
    const res = await get(appFor({ user_id: 'u1' }, {}), '/customer/authority-consent');
    expect(res.status).toBe(400);
  });

  it('200 owner → curated live state + can_revoke true', async () => {
    const dal = {
      getCustomerAuthorityState: vi.fn(async () =>
        authorityState({
          unlocked: true, operator_approved: true, consent_acked: true,
          consent: {
            full_name_typed: 'Jane Smith', consent_acked_at: '2026-06-15T00:00:00Z',
            consent_acked_by: 'u1', consent_version: 'authority_v1',
            scopes_confirmed: { watch_mode: true }, operator_approved_at: '2026-06-15T01:00:00Z',
            operator_approved_by: 'op', ip_address: '1.2.3.4', user_agent: 'UA', metadata: { email: 'j@acme.com' },
          },
        })
      ),
    };
    const res = await get(appFor({ user_id: 'u1', workspace_id: 'org_acme', role: 'owner' }, dal), '/customer/authority-consent');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>;
    expect(json.authority.unlocked).toBe(true);
    expect(json.can_revoke).toBe(true);
    expect(json.consent.full_name_typed).toBe('Jane Smith');
    // curated: no raw provenance leaked to the client
    expect(json.consent.ip_address).toBeUndefined();
    expect(json.consent.user_agent).toBeUndefined();
    expect(json.consent.metadata).toBeUndefined();
  });

  it('200 viewer → can_revoke false; consent null when none recorded', async () => {
    const dal = { getCustomerAuthorityState: vi.fn(async () => authorityState({ consent: null })) };
    const res = await get(appFor({ user_id: 'u1', workspace_id: 'org_acme', role: 'viewer' }, dal), '/customer/authority-consent');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>;
    expect(json.can_revoke).toBe(false);
    expect(json.consent).toBe(null);
  });
});

describe('POST /customer/authority-consent/revoke', () => {
  // After revoke, getCustomerAuthorityState returns the locked state (the active row is gone).
  // The DAL records the audit_logs entry transactionally inside revokeCustomerAuthority — the route
  // no longer calls appendAuditLog, so the mock does not need it.
  const lockedAfterRevoke = () => ({
    revokeCustomerAuthority: vi.fn(async () => ({ id: 'cac1', revoked_at: 'now' })),
    getCustomerAuthorityState: vi.fn(async () =>
      authorityState({ unlocked: false, operator_approved: false, consent_acked: false })
    ),
  });

  it('401 when unauthenticated', async () => {
    const res = await post(appFor({}, lockedAfterRevoke()), '/customer/authority-consent/revoke', { full_name_typed: 'Jane Smith' });
    expect(res.status).toBe(401);
  });

  it('400 when no workspace (org) scope', async () => {
    const res = await post(appFor({ user_id: 'u1' }, lockedAfterRevoke()), '/customer/authority-consent/revoke', { full_name_typed: 'Jane Smith' });
    expect(res.status).toBe(400);
  });

  it('403 when caller is a viewer (not owner/operator) — revoke NOT called', async () => {
    const dal = lockedAfterRevoke();
    const res = await post(
      appFor({ user_id: 'u1', workspace_id: 'org_acme', role: 'viewer' }, dal),
      '/customer/authority-consent/revoke',
      { full_name_typed: 'Jane Smith' }
    );
    expect(res.status).toBe(403);
    expect(dal.revokeCustomerAuthority).not.toHaveBeenCalled();
  });

  it('400 when full_name_typed too short (re-attestation required) — revoke NOT called', async () => {
    const dal = lockedAfterRevoke();
    const res = await post(
      appFor({ user_id: 'u1', workspace_id: 'org_acme', role: 'owner' }, dal),
      '/customer/authority-consent/revoke',
      { full_name_typed: 'J' }
    );
    expect(res.status).toBe(400);
    expect(dal.revokeCustomerAuthority).not.toHaveBeenCalled();
  });

  it('200 owner revokes → re-locked state + revoked_by/reason/re_attest_name forwarded to the DAL', async () => {
    const dal = lockedAfterRevoke();
    const res = await post(
      appFor({ user_id: 'owner1', workspace_id: 'org_acme', role: 'owner' }, dal),
      '/customer/authority-consent/revoke',
      { full_name_typed: 'Jane Smith', reason: 'no longer using Drive' }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>;
    expect(json.revoked).toBe(true);
    expect(json.authority.unlocked).toBe(false);
    expect(json.message).toMatch(/re-authorize/i);
    expect(dal.revokeCustomerAuthority).toHaveBeenCalledOnce();
    // The DAL writes the audit_logs entry transactionally; the route forwards actor + re-attestation.
    expect(dal.revokeCustomerAuthority.mock.calls[0][0]).toMatchObject({
      workspace_id: 'org_acme',
      revoked_by: 'owner1',
      revoked_reason: 'no longer using Drive',
      re_attest_name: 'Jane Smith',
    });
  });

  it('200 operator can revoke (owner/operator gate)', async () => {
    const res = await post(
      appFor({ user_id: 'op1', workspace_id: 'org_acme', role: 'operator' }, lockedAfterRevoke()),
      '/customer/authority-consent/revoke',
      { full_name_typed: 'Op Erator' }
    );
    expect(res.status).toBe(200);
  });

  it('404 when there is no active row to revoke (already revoked or never consented)', async () => {
    const dal = {
      revokeCustomerAuthority: vi.fn(async () => {
        const err: any = new Error('no active authority/consent to revoke for this workspace');
        err.code = 'NOT_FOUND';
        err.status = 404;
        throw err;
      }),
      getCustomerAuthorityState: vi.fn(),
    };
    const res = await post(
      appFor({ user_id: 'owner1', workspace_id: 'org_acme', role: 'owner' }, dal),
      '/customer/authority-consent/revoke',
      { full_name_typed: 'Jane Smith' }
    );
    expect(res.status).toBe(404);
    // a failed revoke must not fall through to reading/returning state as success
    expect(dal.getCustomerAuthorityState).not.toHaveBeenCalled();
  });
});

describe('POST /customer/invites', () => {
  const unlockedDal = () => ({
    getCustomerAuthorityState: vi.fn(async () =>
      authorityState({ unlocked: true, operator_approved: true, consent_acked: true })
    ),
  });

  it('401 when unauthenticated', async () => {
    const res = await post(appFor({}, unlockedDal()), '/customer/invites', { email: 'a@acme.com' });
    expect(res.status).toBe(401);
  });

  it('400 when no workspace', async () => {
    const res = await post(appFor({ user_id: 'u1' }, unlockedDal()), '/customer/invites', { email: 'a@acme.com' });
    expect(res.status).toBe(400);
  });

  it('403 when caller is a viewer (not owner/operator)', async () => {
    const res = await post(
      appFor({ user_id: 'u1', workspace_id: 'org_acme', role: 'viewer' }, unlockedDal()),
      '/customer/invites',
      { email: 'a@acme.com' }
    );
    expect(res.status).toBe(403);
  });

  it('403 AUTHORITY_REQUIRED when authority not unlocked', async () => {
    const res = await post(
      appFor(
        { user_id: 'u1', workspace_id: 'org_acme', role: 'owner' },
        { getCustomerAuthorityState: vi.fn(async () => authorityState({ unlocked: false })) }
      ),
      '/customer/invites',
      { email: 'a@acme.com' }
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(json)).toMatch(/AUTHORITY_REQUIRED/);
  });

  it('400 on invalid invitee email', async () => {
    const res = await post(
      appFor({ user_id: 'u1', workspace_id: 'org_acme', role: 'owner' }, unlockedDal()),
      '/customer/invites',
      { email: 'not-an-email' }
    );
    expect(res.status).toBe(400);
  });

  it('201 owner invites a teammate (default role maps to org:member)', async () => {
    const res = await post(
      appFor({ user_id: 'u1', workspace_id: 'org_acme', role: 'owner' }, unlockedDal()),
      '/customer/invites',
      { email: 'Alice@Acme.com' }
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, any>;
    expect(json.invited.email).toBe('alice@acme.com');
    expect(json.invited.role).toBe('org:member');
    expect(json.message).toMatch(/alice@acme.com/);
  });

  it('201 admin role maps to org:admin (operator caller)', async () => {
    const res = await post(
      appFor({ user_id: 'u2', workspace_id: 'org_acme', role: 'operator' }, unlockedDal()),
      '/customer/invites',
      { email: 'bob@acme.com', role: 'admin' }
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, any>;
    expect(json.invited.role).toBe('org:admin');
  });
});
