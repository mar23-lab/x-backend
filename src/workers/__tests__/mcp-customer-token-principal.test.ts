// mcp-customer-token-principal.test.ts · Stage-0 MCP unblock (260806)
//
// The issuance-derived customer-token principal, decided by the SAME canActOnSpine core as humans.
// Pure — no DB, no Hono. These pin the doctrine: an agent token REPORTS work; it never DECIDES.
// The pre-fix behaviour (svc_customer_* → mode 'watch' + zero entitlements → every write 403)
// is kept as the negative control via the viewer token.
import { describe, it, expect } from 'vitest';
import {
  buildCustomerTokenPrincipal,
  CUSTOMER_TOKEN_ALLOWED_ACTIONS,
  CUSTOMER_TOKEN_DENIED_ACTIONS,
} from '../dal/principal-hydration';
import { canActOnSpine, type SpineAction } from '../lib/permissions';

const opAuth = {
  user_id: 'svc_customer_tok_1',
  workspace_id: 'ws_a',
  role: 'operator',
  auth_method: 'service_principal',
  service_principal: 'customer_token',
  token_expires_at: new Date(Date.now() + 86400000).toISOString(),
} as never;

const viewerAuth = { ...(opAuth as object), role: 'viewer' } as never;

describe('customer-token issuance-derived principal', () => {
  it('operator token may perform every REPORT-class action', () => {
    const p = buildCustomerTokenPrincipal(opAuth);
    for (const action of CUSTOMER_TOKEN_ALLOWED_ACTIONS) {
      const d = canActOnSpine(p, 'xlooop', 'operator', action as SpineAction);
      expect(d, action).toEqual({ allowed: true, reason: 'active_entitlement' });
    }
  });

  it('operator token can NEVER decide — sign-off/approval/revoke/delete are denied in the entitlement itself', () => {
    const p = buildCustomerTokenPrincipal(opAuth);
    for (const action of CUSTOMER_TOKEN_DENIED_ACTIONS) {
      const d = canActOnSpine(p, 'xlooop', 'operator', action as SpineAction);
      expect(d.allowed, action).toBe(false);
      expect(d.reason, action).toBe('action_denied'); // deny-wins, not merely absent from the allow list
    }
  });

  it('actions outside the allow list fail closed (member:invite, token:create, policy:write)', () => {
    const p = buildCustomerTokenPrincipal(opAuth);
    for (const action of ['member:invite', 'token:create', 'policy:write', 'customer_data:export'] as SpineAction[]) {
      const d = canActOnSpine(p, 'xlooop', 'operator', action);
      expect(d.allowed, action).toBe(false);
    }
  });

  it('viewer token cannot write at all — watch mode, empty allow list (the pre-fix negative control)', () => {
    const p = buildCustomerTokenPrincipal(viewerAuth);
    // The spine-authority branch derives mode 'watch' for a viewer token; the mode axis denies first.
    expect(canActOnSpine(p, 'xlooop', 'watch', 'evidence:submit')).toEqual({ allowed: false, reason: 'mode_requires_operator' });
    // Even if a caller could assert operator mode, the issuance entitlement for a viewer has no
    // operator mode and no actions — defence in depth on the entitlement axis.
    const forced = canActOnSpine(p, 'xlooop', 'operator', 'evidence:submit');
    expect(forced.allowed).toBe(false);
  });

  it('an expired token is denied via session expiry (the auth layer would refuse it first — belt and braces)', () => {
    const expired = { ...(opAuth as object), token_expires_at: new Date(Date.now() - 1000).toISOString() } as never;
    const p = buildCustomerTokenPrincipal(expired);
    expect(canActOnSpine(p, 'xlooop', 'operator', 'evidence:submit')).toEqual({ allowed: false, reason: 'session_expired' });
  });
});
