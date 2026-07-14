// principal-redaction.test.ts · A-W4.1 (260707) — proves the customer-safe redaction of the raw human
// principal id on the event read model. Policy (PRINCIPAL_INSTRUMENT_LINEAGE.md §Customer-safe redaction):
// the low-trust roles (client/viewer) and public_safe surfaces never receive a raw internal user id; the
// accountable roles (owner/operator/member) do. A regression that leaks authorized_by_user_id to a client
// — or that over-redacts and strips it from an operator's audit view — fails here.

import { describe, it, expect } from 'vitest';
import { redactPrincipalForRole } from '../dal/event-store';

const rowWith = (id: string | null) => ({
  id: 'ev1',
  authorized_by_user_id: id,
  instrument_kind: 'human',
  authority_source: 'role',
  request_id: 'req_1',
});

describe('A-W4.1 redactPrincipalForRole', () => {
  it('nulls the raw principal for the low-trust roles (client, viewer)', () => {
    for (const role of ['client', 'viewer']) {
      expect(redactPrincipalForRole(rowWith('user_operator_marat'), role).authorized_by_user_id).toBeNull();
    }
  });

  it('preserves the principal for the accountable roles (owner, operator — the real runtime roles)', () => {
    for (const role of ['owner', 'operator']) {
      expect(redactPrincipalForRole(rowWith('user_operator_marat'), role).authorized_by_user_id)
        .toBe('user_operator_marat');
    }
  });

  it('redacts for a phantom "member" role — it is NOT a runtime auth role and was dropped from the allow-list', () => {
    // Guards against a future RBAC rework silently granting principal exposure to a role literal that was
    // only ever aspirational. Real roles are owner|operator|viewer|client (dal/types/access.ts).
    expect(redactPrincipalForRole(rowWith('user_x'), 'member').authorized_by_user_id).toBeNull();
  });

  it('keeps the SAFE lineage fields intact even when the principal is redacted (client sees WHAT, not WHO)', () => {
    const out = redactPrincipalForRole(rowWith('user_x'), 'client');
    expect(out.authorized_by_user_id).toBeNull();
    expect(out.instrument_kind).toBe('human');
    expect(out.authority_source).toBe('role');
    expect(out.request_id).toBe('req_1');
  });

  it('is a no-op on an already-null principal (system-policy write) for any role', () => {
    expect(redactPrincipalForRole(rowWith(null), 'client').authorized_by_user_id).toBeNull();
    expect(redactPrincipalForRole(rowWith(null), 'operator').authorized_by_user_id).toBeNull();
  });

  it('FAILS CLOSED: an unknown/absent role is redacted (never a silent leak of an internal id)', () => {
    expect(redactPrincipalForRole(rowWith('user_x'), undefined).authorized_by_user_id).toBeNull();
    expect(redactPrincipalForRole(rowWith('user_x'), 'some_future_role').authorized_by_user_id).toBeNull();
  });
});
