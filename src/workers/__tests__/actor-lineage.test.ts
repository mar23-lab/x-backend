// actor-lineage.test.ts · A-W4/P6 (260707) — proves the principal-instrument derivation per auth shape,
// and pins the vocabulary to the new UI's ACTOR_KIND enum (human|agent|system|external — an api_token is
// NOT an actor kind; it is authority_source 'token_scope'). A drift in lineageFor's defaults (e.g. a
// token write losing its principal, or a human write mislabelled 'agent') fails here.

import { describe, it, expect } from 'vitest';
import { lineageFor, systemLineage, INSTRUMENT_KINDS, AUTHORITY_SOURCES } from '../lib/actor-lineage';

describe('A-W4 vocabulary (UI-aligned, frozen)', () => {
  it('instrument kinds are exactly the UI ACTOR_KIND enum', () => {
    expect([...INSTRUMENT_KINDS]).toEqual(['human', 'agent', 'system', 'external']);
  });
  it('authority sources are the 5 defined grants', () => {
    expect([...AUTHORITY_SOURCES].sort()).toEqual(
      ['explicit_approval', 'operator_identity', 'role', 'system_policy', 'token_scope'],
    );
  });
});

describe('A-W4 lineageFor', () => {
  it('a Clerk human acting directly: own principal, human instrument, role authority', () => {
    expect(lineageFor({ user_id: 'u1', role: 'owner' })).toEqual({
      authorized_by_user_id: 'u1',
      instrument_kind: 'human',
      authority_source: 'role',
    });
  });

  it('a customer connector token: principal = bound identity, agent instrument, token_scope authority', () => {
    expect(lineageFor({ user_id: 'u_bound', role: 'operator', service_principal: 'customer_token' })).toEqual({
      authorized_by_user_id: 'u_bound',
      instrument_kind: 'agent',
      authority_source: 'token_scope',
    });
  });

  it('a canary service principal also derives token_scope (never mislabelled human/role)', () => {
    const l = lineageFor({ user_id: 'canary', role: 'viewer', service_principal: 'canary_read' });
    expect(l.instrument_kind).toBe('agent');
    expect(l.authority_source).toBe('token_scope');
  });

  it('overrides: an engine-emitted event under a human authorization', () => {
    const l = lineageFor({ user_id: 'u1', role: 'owner' }, { instrument_kind: 'system' });
    expect(l).toEqual({ authorized_by_user_id: 'u1', instrument_kind: 'system', authority_source: 'role' });
  });

  it('missing user id → null principal (never a fabricated one)', () => {
    expect(lineageFor({ user_id: '', role: 'owner' }).authorized_by_user_id).toBeNull();
  });
});

describe('A-W4 systemLineage', () => {
  it('scheduled/system writes: no principal, system instrument, system_policy authority', () => {
    expect(systemLineage()).toEqual({
      authorized_by_user_id: null,
      instrument_kind: 'system',
      authority_source: 'system_policy',
    });
  });
});
