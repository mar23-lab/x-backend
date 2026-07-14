// context-packet.test.ts · AR-2.2 (260713) · proves the context-packet kernel.
// The invariants that matter: customer-safe (no internal ids), and a deterministic fingerprint that is
// stable across time/receipt but changes when the actual context (skills/scope/redaction) changes.

import { describe, it, expect } from 'vitest';
import { buildContextPacket, type ContextPacketInput } from '../lib/context-packet';
import { resolveRoleAndSkills } from '../lib/role-skill-resolver';
import { catalogBindingsIfEnabled } from '../lib/role-skill-catalog-loader';
import contract from '../../../docs/contracts/context-packet.v1.json';

const NOW = new Date('2026-07-13T00:00:00Z');
const LATER = new Date('2026-07-13T00:05:00Z');

// a real resolution from the AR-2.1 keystone (owner + packet:create resolves to real skills)
const { bindings } = catalogBindingsIfEnabled({ ROLE_SKILL_CATALOG_ENABLED: 'true' })!;
const resolution = resolveRoleAndSkills(
  { tenant: 'ws_1', principal: 'usr_secret_1', role: 'owner', mode: 'operator', action: 'packet:create', entitlementActive: true, tenantMismatch: false },
  bindings,
  NOW,
);

const baseInput: ContextPacketInput = {
  tenant: 'ws_1',
  principal: 'usr_secret_1',
  role: 'owner',
  mode: 'operator',
  intent: 'intent_abc',
  resolution,
  scope: { event_count: 12, document_count: 3, unpromoted_document_count: 1, source_count: 4 },
  redaction_profile: 'owner-full',
  client_empty: false,
  receipt_ref: 'rcpt_1',
};

describe('buildContextPacket — shape + capability', () => {
  const p = buildContextPacket(baseInput, NOW);

  it('captures the resolved capability + scope counts', () => {
    expect(p.schema_id).toBe('xlooop.context_packet.v1');
    expect(p.skill_coverage).toBe('resolved');
    expect(p.selected_skills.length).toBeGreaterThan(0);
    expect(p.context_scope.event_count).toBe(12);
    expect(p.policy_summary).toContain('owner');
    expect(p.freshness.generated_at).toBe(NOW.toISOString());
  });
});

describe('CUSTOMER-SAFE invariant', () => {
  const p = buildContextPacket({ ...baseInput, scope: { event_count: 12, document_count: 3, unpromoted_document_count: 1, source_count: 4 } }, NOW);
  const json = JSON.stringify(p);

  it('emits none of the contract forbidden fields', () => {
    for (const forbidden of contract.forbidden_fields) {
      expect(Object.prototype.hasOwnProperty.call(p, forbidden)).toBe(false);
    }
  });

  it('carries counts, not event/document ids, and no graph topology', () => {
    expect(json).not.toContain('event_ids');
    // graph TOPOLOGY must be absent — note `raw_graph_export` is a customer-safe DENIED-tool label
    // (named-but-never-invoked), so we check the topology tokens, not the substring 'graph'.
    expect(json).not.toContain('graph_node');
    expect(json).not.toContain('graph_edge');
    expect(json).not.toContain('prompt');
    // principal/tenant are internal-linkage fields (allowed), but the policy_summary must not leak them
    expect(p.policy_summary).not.toContain('usr_secret_1');
  });
});

describe('deterministic fingerprint', () => {
  it('is stable across generated_at + receipt_ref (dedup)', () => {
    const a = buildContextPacket(baseInput, NOW);
    const b = buildContextPacket({ ...baseInput, receipt_ref: 'rcpt_DIFFERENT' }, LATER);
    expect(a.context_fingerprint).toBe(b.context_fingerprint);
    expect(a.freshness.generated_at).not.toBe(b.freshness.generated_at); // time differs, fingerprint does not
  });

  it('changes when the actual context changes (more events)', () => {
    const a = buildContextPacket(baseInput, NOW);
    const b = buildContextPacket({ ...baseInput, scope: { ...baseInput.scope, event_count: 99 } }, NOW);
    expect(a.context_fingerprint).not.toBe(b.context_fingerprint);
  });

  it('changes when the redaction profile changes', () => {
    const a = buildContextPacket(baseInput, NOW);
    const b = buildContextPacket({ ...baseInput, redaction_profile: 'client-empty', client_empty: true }, NOW);
    expect(a.context_fingerprint).not.toBe(b.context_fingerprint);
    expect(/^[a-f0-9]{8}$/.test(a.context_fingerprint)).toBe(true);
  });
});
