// session-readiness-gate.test.ts · R-P1 (260628) · closes the quote-bug coverage gap (P-D2)
//
// The Part O.4 failure: CUSTOMER_INAPP_READINESS_GATE was set in the Cloudflare dashboard
// to the value `"true"` (WITH quotes). A strict `=== 'true'` read that as false, so the
// in-app readiness journey stayed dormant — and NO automated test covered the
// flag → state:'needs_readiness' path (it needed a real Clerk sign-up to exercise). It was
// caught only from an operator screenshot. This integration test closes that gap: it drives
// the session route end-to-end with a mocked Clerk JWT + a stub DAL and asserts the QUOTED
// flag value still activates the gate (via envFlagTrue), plus the unquoted and off controls.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Mock Clerk JWT verification → a Clerk-org first session for a NON-operator customer
// (codelooop23@gmail.com / Honest & Young), so the operator self-bootstrap is skipped.
vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async () => ({
    sub: 'user_codelooop',
    org_id: 'org_hy',
    email: 'codelooop23@gmail.com',
    org_name: 'Honest & Young',
  })),
}));

import { sessionRoute } from '../routes/session';

// Clerk-org first session: no workspace yet (authenticated_no_access) and no invited access
// request (listAccessRequests → []), so the route reaches the Clerk-org auto-provision branch
// where the readiness gate decides provision-now vs needs_readiness.
const dalStub = {
  getSessionEntitlement: async () => ({ state: 'authenticated_no_access' }),
  listAccessRequests: async () => [],
};

function appFor() {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('dal', dalStub as never);
    await next();
  });
  app.route('/api/v1', sessionRoute);
  return app;
}

// MBP_OWNER_USER_ID intentionally unset → user_codelooop is NOT the operator → the operator
// self-bootstrap (session.ts:148) is skipped and the regular entitlement gate runs.
const BASE_ENV = {
  CLERK_SECRET_KEY: 'x', // verifyToken is mocked; value unused
  CUSTOMER_AUTO_PROVISION_ON_SESSION: 'true',
  CUSTOMER_AUTO_PROVISION_FROM_CLERK_ORG: 'true',
};

async function callSession(env: Record<string, string>) {
  const res = await appFor().request(
    '/api/v1/session',
    { headers: { Authorization: 'Bearer faketoken' } },
    env as never,
  );
  return { status: res.status, body: (await res.json()) as { state?: string } };
}

describe('session route · readiness gate activation (R-P1 · quote-bug guard)', () => {
  it('QUOTED flag value `"true"` still activates the gate → state needs_readiness', async () => {
    // The exact Part O.4 failure value: the dashboard stored `"true"` with quotes.
    const { status, body } = await callSession({ ...BASE_ENV, CUSTOMER_INAPP_READINESS_GATE: '"true"' });
    expect(status).toBe(200);
    expect(body.state).toBe('needs_readiness');
  });

  it('unquoted `true` → state needs_readiness (the canonical case)', async () => {
    const { body } = await callSession({ ...BASE_ENV, CUSTOMER_INAPP_READINESS_GATE: 'true' });
    expect(body.state).toBe('needs_readiness');
  });

  it('gate off → NOT needs_readiness (no surprise activation)', async () => {
    // Readiness gate off AND clerk-org provision off → the Clerk-org branch is not taken,
    // so the customer stays authenticated_no_access (the journey does not render).
    const { body } = await callSession({
      ...BASE_ENV,
      CUSTOMER_AUTO_PROVISION_FROM_CLERK_ORG: 'false',
      CUSTOMER_INAPP_READINESS_GATE: 'false',
    });
    expect(body.state).not.toBe('needs_readiness');
  });
});
