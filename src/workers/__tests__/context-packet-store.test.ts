// context-packet-store.test.ts · AR-2.4 (260713) · proves the context_packets writer (mig-071).
//
// Locks (a) the INSERT column shape vs the mig-071 DDL, (b) that a real buildContextPacket() output maps
// through the writer with COUNTS + labels only (no ids/graph/prompt), (c) that the integrity seal hashes
// always + signs only with a secret. Same mock-`Sql` pattern as role-skill-resolution-store.test.

import { describe, it, expect } from 'vitest';
import {
  insertContextPacketRow,
  contextPacketSigningPayload,
  sealContextPacket,
} from '../dal/context-packet-store';
import { buildContextPacket, type ContextPacketInput } from '../lib/context-packet';
import { resolveRoleAndSkills } from '../lib/role-skill-resolver';
import { catalogBindingsIfEnabled } from '../lib/role-skill-catalog-loader';

type Row = Record<string, any>;
function makeSql() {
  const calls: Array<{ query: string; values: any[] }> = [];
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    calls.push({ query: strings.join(' ? ').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve([] as Row[]);
  };
  sql.calls = calls;
  return sql;
}

const NOW = new Date('2026-07-13T00:00:00Z');
const { bindings } = catalogBindingsIfEnabled({ ROLE_SKILL_CATALOG_ENABLED: 'true' })!;
const resolution = resolveRoleAndSkills(
  { tenant: 'ws_1', principal: 'usr_secret_1', role: 'owner', mode: 'operator', action: 'packet:create', entitlementActive: true, tenantMismatch: false },
  bindings,
  NOW,
);
const input: ContextPacketInput = {
  tenant: 'ws_1', principal: 'usr_secret_1', role: 'owner', mode: 'operator', intent: 'intent_abc',
  resolution, scope: { event_count: 12, document_count: 3, unpromoted_document_count: 1, source_count: 4 },
  redaction_profile: 'owner-full', client_empty: false, receipt_ref: 'rsr_9',
};
const UNSIGNED = { content_sha256: 'b'.repeat(64), signature_alg: 'none' as const, signature: null, signing_key_id: null };

describe('insertContextPacketRow — INSERT shape + kernel mapping', () => {
  it('targets context_packets with a cpk_ id and maps the kernel counts + labels (no ids/graph/prompt)', async () => {
    const packet = buildContextPacket(input, NOW);
    const sql = makeSql();
    await insertContextPacketRow(sql, packet, UNSIGNED);
    expect(sql.calls.length).toBe(1);
    const { query, values } = sql.calls[0];
    expect(query).toContain('INSERT INTO context_packets');
    // the scope COUNTS are individual columns, not a JSON blob of ids
    expect(query).toContain('event_count');
    expect(query).toContain('context_fingerprint');
    expect(values[0]).toMatch(/^cpk_/);
    expect(values).toContain('ws_1');
    expect(values).toContain(12);           // event_count value bound
    expect(values).toContain('owner-full'); // redaction_profile
    expect(values).toContain('rsr_9');      // receipt_ref
    // customer-safe: the serialized bound values carry no forbidden tokens
    const flat = JSON.stringify(values);
    expect(flat).not.toContain('event_ids');
    expect(flat).not.toContain('graph_node');
    expect(flat).not.toContain('prompt');
  });

  it('binds NULL intent_ref + receipt_ref without coercion', async () => {
    const packet = buildContextPacket({ ...input, intent: null, receipt_ref: null }, NOW);
    const sql = makeSql();
    await insertContextPacketRow(sql, packet, UNSIGNED);
    expect(sql.calls[0].values).toContain(null);
  });
});

describe('context-packet seal — deterministic + secret-gated', () => {
  it('signing payload is stable across generated_at (excludes it, like the fingerprint)', () => {
    const a = contextPacketSigningPayload(buildContextPacket(input, NOW));
    const b = contextPacketSigningPayload(buildContextPacket(input, new Date('2026-07-13T09:00:00Z')));
    expect(a).toBe(b);
    expect(JSON.parse(a).schema_id).toBe('xlooop.context_packet_signature_payload.v1');
  });

  it('sealContextPacket hashes always + signs only when a secret is configured', async () => {
    const packet = buildContextPacket(input, NOW);
    const unsigned = await sealContextPacket(undefined, packet);
    expect(unsigned.signature_alg).toBe('none');
    expect(unsigned.signature).toBeNull();
    const signed = await sealContextPacket('secret', packet, 'k1');
    expect(signed.signature_alg).toBe('HS256');
    expect(signed.signature).not.toBeNull();
    expect(signed.content_sha256).toBe(unsigned.content_sha256); // same content → same hash
  });
});
