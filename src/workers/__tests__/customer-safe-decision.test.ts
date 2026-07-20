// customer-safe-decision.test.ts · AR-0 (260713) · proves the shared customer-safe serializer.
// Core invariant: flag OFF returns the input BY REFERENCE (byte-identical shadow-first landing);
// flag ON emits a deny-by-default customer-safe projection with zero internal ids / engine names.

import { describe, it, expect } from 'vitest';
import {
  customerSafeChat,
  stripInternalProvisioning,
  INTERNAL_ENTITLEMENT_KEYS,
  customerSafeSerializerEnabled,
} from '../lib/customer-safe-decision';

describe('customerSafeChat', () => {
  const raw = {
    answer: 'here is your summary',
    generated_by: 'claude',
    model: 'claude-3-5-sonnet-internal',
    grounded_on: { event_ids: ['evt_a', 'evt_b', 'evt_c'], assembly: { internal: true } },
    mode: 'ask',
    llm_requested: true,
    claude_available: true,
  };

  it('OFF returns the input BY REFERENCE (byte-identical)', () => {
    const out = customerSafeChat(raw, false);
    expect(out).toBe(raw); // same reference — zero behavior change
  });

  it('ON drops the internal model id and the internal grounded_on ids', () => {
    const out = customerSafeChat(raw, true) as Record<string, unknown>;
    expect(out).not.toHaveProperty('model');
    expect(out).not.toHaveProperty('llm_requested'); // allow-list: not in the safe surface
    expect(out.grounded_on).toEqual({ evidence_count: 3 });
    expect(JSON.stringify(out)).not.toContain('evt_a');
    expect(JSON.stringify(out)).not.toContain('internal');
  });

  it('ON collapses every engine name to a coarse safe label', () => {
    expect((customerSafeChat({ ...raw, generated_by: 'claude' }, true) as { generated_by: string }).generated_by).toBe('assistant');
    expect((customerSafeChat({ ...raw, generated_by: 'llm' }, true) as { generated_by: string }).generated_by).toBe('assistant');
    expect((customerSafeChat({ ...raw, generated_by: 'workers_ai' }, true) as { generated_by: string }).generated_by).toBe('assistant');
    expect((customerSafeChat({ ...raw, generated_by: 'deterministic' }, true) as { generated_by: string }).generated_by).toBe('rule_based');
    // unknown / absent → safe default
    expect((customerSafeChat({ ...raw, generated_by: 'mbp-secret-engine-v9' }, true) as { generated_by: string }).generated_by).toBe('assistant');
  });

  it('ON preserves the answer + mode + claude_available and null grounded_on', () => {
    const out = customerSafeChat({ ...raw, grounded_on: null }, true) as Record<string, unknown>;
    expect(out.answer).toBe('here is your summary');
    expect(out.mode).toBe('ask');
    expect(out.claude_available).toBe(true);
    expect(out.grounded_on).toBeNull();
  });
});

describe('stripInternalProvisioning', () => {
  const ent = {
    state: 'approved_workspace',
    message: 'welcome',
    user: { role: 'owner' },
    auto_provisioned_from_access_request_id: 'areq_internal_uuid_123',
    auto_provisioned_from: 'clerk_org',
    auto_provision_skipped_reason: 'none',
    operator_bootstrapped: { by: 'op_internal', at: 'ts' },
  };

  it('OFF returns the input BY REFERENCE (byte-identical)', () => {
    expect(stripInternalProvisioning(ent, false)).toBe(ent);
  });

  it('ON removes every internal provisioning key', () => {
    const out = stripInternalProvisioning(ent, true) as Record<string, unknown>;
    for (const k of INTERNAL_ENTITLEMENT_KEYS) expect(out).not.toHaveProperty(k);
    expect(JSON.stringify(out)).not.toContain('areq_internal_uuid_123');
    expect(JSON.stringify(out)).not.toContain('op_internal');
  });

  it('ON preserves customer-consumed fields and adds a coarse auto_provisioned boolean', () => {
    const out = stripInternalProvisioning(ent, true) as Record<string, unknown>;
    expect(out.state).toBe('approved_workspace');
    expect(out.message).toBe('welcome');
    expect(out.user).toEqual({ role: 'owner' });
    expect(out.auto_provisioned).toBe(true);
  });

  it('ON sets auto_provisioned=false when there was no provisioning id', () => {
    const out = stripInternalProvisioning({ state: 'pending_access' }, true) as Record<string, unknown>;
    expect(out.auto_provisioned).toBe(false);
  });
});

// Stage-2 leak-boundary regression guard (260720): the two serializers exist to stop internal fields
// reaching a customer payload. The named-key tests above prove TODAY's leaks are closed; these prove the
// deny-by-default posture holds when a NEW internal field is added upstream — the actual failure class
// (a field added to ChatDecisionLike / an entitlement without anyone updating the serializer).
describe('leak-boundary regression guard · novel internal fields', () => {
  it('customerSafeChat ON drops an unrecognised internal field by allow-list construction', () => {
    const withNovelLeak = {
      answer: 'a',
      generated_by: 'claude',
      mode: 'ask',
      grounded_on: { event_ids: ['evt_x'] },
      // a field a future change might add — the serializer must never emit it
      internal_prompt_trace: 'SYSTEM: you are mbp-secret-engine-v9 <internal chain>',
      tenant_debug_scope: { rls_bypass: true, owner_uuid: 'usr_internal_777' },
    };
    const out = customerSafeChat(withNovelLeak, true) as Record<string, unknown>;
    expect(out).not.toHaveProperty('internal_prompt_trace');
    expect(out).not.toHaveProperty('tenant_debug_scope');
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('mbp-secret-engine-v9');
    expect(blob).not.toContain('usr_internal_777');
    expect(blob).not.toContain('rls_bypass');
    // exactly the allow-listed keys survive
    expect(Object.keys(out).sort()).toEqual(['answer', 'generated_by', 'grounded_on', 'mode']);
  });

  it('stripInternalProvisioning ON keeps the deny-list current: every declared internal key is actually removed', () => {
    // build an entitlement carrying every INTERNAL_ENTITLEMENT_KEY plus a customer-legit field
    const ent: Record<string, unknown> = { state: 'approved_workspace' };
    for (const k of INTERNAL_ENTITLEMENT_KEYS) ent[k] = `INTERNAL_${k}`;
    const out = stripInternalProvisioning(ent, true) as Record<string, unknown>;
    for (const k of INTERNAL_ENTITLEMENT_KEYS) {
      expect(out).not.toHaveProperty(k);
      expect(JSON.stringify(out)).not.toContain(`INTERNAL_${k}`);
    }
    expect(out.state).toBe('approved_workspace'); // customer-legit field preserved
  });
});

describe('customerSafeSerializerEnabled (E7 fail-CLOSED gate, 260713)', () => {
  it('strips by DEFAULT — absent/empty/unknown flag returns true (fail-closed, never leaks)', () => {
    expect(customerSafeSerializerEnabled(undefined)).toBe(true);
    expect(customerSafeSerializerEnabled('')).toBe(true);
    expect(customerSafeSerializerEnabled('anything')).toBe(true);
  });
  it('turns OFF only on an EXPLICIT disable value (case/space-insensitive)', () => {
    for (const v of ['false', 'off', '0', 'no', 'disabled', 'FALSE', ' Off ']) {
      expect(customerSafeSerializerEnabled(v)).toBe(false);
    }
  });
  it("prod value 'true' stays true (byte-identical to the prior envFlagTrue gate)", () => {
    expect(customerSafeSerializerEnabled('true')).toBe(true);
  });
});

describe('customerSafeChat · Option A — preserve the customer-safe source count, drop internal ids', () => {
  it('keeps sources {total, connected, providers[{provider, event_count}]} and drops event_ids + internal source fields', () => {
    const out = customerSafeChat({
      answer: 'a', generated_by: 'llm', mode: 'ask',
      grounded_on: {
        event_ids: ['evt_a', 'evt_b'],
        sources: { total: 3, connected: 2, providers: [{ provider: 'gmail', event_count: 4, source_id: 'src_internal_1', scopes: ['x'] }] },
      },
    }, true) as { grounded_on: { evidence_count: number; sources?: { total?: number; connected?: number; providers?: { provider: string; event_count: number }[] } } };
    expect(out.grounded_on.evidence_count).toBe(2);
    expect(out.grounded_on.sources).toEqual({ total: 3, connected: 2, providers: [{ provider: 'gmail', event_count: 4 }] });
    expect(JSON.stringify(out)).not.toContain('src_internal_1');
    expect(JSON.stringify(out)).not.toContain('evt_a');
    expect(JSON.stringify(out)).not.toContain('scopes');
  });
});

