// role-skill-resolution-store.test.ts · AR-2.3 (260713) · proves the closed-loop evidence writers.
//
// Scope: the two mig-070 "reserved for the closed loop" tables — skill_invocation_receipts +
// closing_attestations — and their DAL writers (insertSkillInvocationReceiptRow /
// insertClosingAttestationRow) plus the canonical signing payloads they hash. These are INERT (no live
// INSERT site yet), so the tests lock (a) the INSERT column shape against the mig-070 DDL, (b) value
// mapping incl. the enum + array + optional-signature fields, (c) that the signing payload is stable +
// customer-safe (linkage only, no skill body/prompt). Same mock-`Sql` pattern as propagation-store.test.

import { describe, it, expect } from 'vitest';
import {
  insertSkillInvocationReceiptRow,
  insertClosingAttestationRow,
  skillInvocationSigningPayload,
  closingAttestationSigningPayload,
  signReceipt,
  type SkillInvocationReceiptInput,
  type ClosingAttestationInput,
} from '../dal/role-skill-resolution-store';

type Row = Record<string, any>;

/** Mock `Sql` tagged-template — records the normalized query text + interpolated values, returns []. */
function makeSql() {
  const calls: Array<{ query: string; values: any[] }> = [];
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ query, values });
    return Promise.resolve([] as Row[]);
  };
  sql.calls = calls;
  return sql;
}

const UNSIGNED = { content_sha256: 'a'.repeat(64), signature_alg: 'none' as const, signature: null, signing_key_id: null };

describe('insertSkillInvocationReceiptRow — INSERT shape + value mapping', () => {
  const input: SkillInvocationReceiptInput = {
    workspace_id: 'ws_1',
    resolution_id: 'rsr_9',
    principal_id: 'usr_1',
    skill_key: 'skill.packet-author',
    skill_version: 'v1',
    action: 'packet:create',
    status: 'completed',
    evidence_ref_ids: ['ev_1', 'ev_2'],
    receipt: UNSIGNED,
  };

  it('targets skill_invocation_receipts with a sir_ id and the mig-070 columns (no signing_key_id)', async () => {
    const sql = makeSql();
    await insertSkillInvocationReceiptRow(sql, input);
    expect(sql.calls.length).toBe(1);
    const { query, values } = sql.calls[0];
    expect(query).toContain('INSERT INTO skill_invocation_receipts');
    // the DDL column set — and crucially NOT signing_key_id (that column does not exist on this table)
    expect(query).toContain('resolution_id');
    expect(query).toContain('evidence_ref_ids');
    expect(query).not.toContain('signing_key_id');
    expect(values[0]).toMatch(/^sir_/);
    expect(values).toContain('ws_1');
    expect(values).toContain('rsr_9');
    expect(values).toContain('completed');
    expect(values).toContainEqual(['ev_1', 'ev_2']); // TEXT[] bound as an array, not JSON
    expect(values).toContain('none');
  });

  it('binds a NULL resolution_id (FK is ON DELETE SET NULL) without coercion', async () => {
    const sql = makeSql();
    await insertSkillInvocationReceiptRow(sql, { ...input, resolution_id: null });
    expect(sql.calls[0].values).toContain(null);
  });
});

describe('insertClosingAttestationRow — INSERT shape + value mapping', () => {
  const input: ClosingAttestationInput = {
    workspace_id: 'ws_1',
    principal_id: 'usr_1',
    correlation_id: 'run_42',
    role_key: 'owner',
    closing_skill: 'skill.wave-closeout',
    outcome: 'attested',
    evidence_ref_ids: ['ev_9'],
    receipt: UNSIGNED,
  };

  it('targets closing_attestations with a cla_ id and the correlation_id + outcome columns', async () => {
    const sql = makeSql();
    await insertClosingAttestationRow(sql, input);
    const { query, values } = sql.calls[0];
    expect(query).toContain('INSERT INTO closing_attestations');
    expect(query).toContain('correlation_id');
    expect(query).toContain('closing_skill');
    expect(query).not.toContain('signing_key_id');
    expect(values[0]).toMatch(/^cla_/);
    expect(values).toContain('run_42');
    expect(values).toContain('attested');
    expect(values).toContainEqual(['ev_9']);
  });
});

describe('signing payloads — stable, customer-safe, hashable', () => {
  const now = '2026-07-13T00:00:00Z';

  it('skill-invocation payload is deterministic + carries only linkage (no skill body/prompt)', () => {
    const ctx = {
      workspace_id: 'ws_1', principal_id: 'usr_1', resolution_id: 'rsr_9',
      skill_key: 'skill.packet-author', skill_version: 'v1', action: 'packet:create',
      status: 'completed' as const, evidence_ref_ids: ['ev_1'], issued_at: now,
    };
    const a = skillInvocationSigningPayload(ctx);
    const b = skillInvocationSigningPayload({ ...ctx });
    expect(a).toBe(b); // order-fixed → reproducible
    const parsed = JSON.parse(a);
    expect(parsed.schema_id).toBe('xlooop.skill_invocation_receipt_signature_payload.v1');
    // customer-safe: no free-text skill body / prompt fields in the signed surface
    expect(a).not.toContain('prompt');
    expect(a).not.toContain('skill_body');
  });

  it('closing payload is deterministic + versioned', () => {
    const ctx = {
      workspace_id: 'ws_1', principal_id: 'usr_1', correlation_id: 'run_42',
      role_key: 'owner', closing_skill: 'skill.wave-closeout', outcome: 'attested' as const,
      evidence_ref_ids: ['ev_9'], issued_at: now,
    };
    expect(closingAttestationSigningPayload(ctx)).toBe(closingAttestationSigningPayload({ ...ctx }));
    expect(JSON.parse(closingAttestationSigningPayload(ctx)).schema_id)
      .toBe('xlooop.closing_attestation_signature_payload.v1');
  });

  it('signReceipt hashes always + signs only when a secret is configured', async () => {
    const payload = skillInvocationSigningPayload({
      workspace_id: 'ws_1', principal_id: 'usr_1', resolution_id: null,
      skill_key: 'skill.x', skill_version: 'v1', action: 'a', status: 'invoked',
      evidence_ref_ids: [], issued_at: now,
    });
    const unsigned = await signReceipt(undefined, payload);
    expect(unsigned.signature_alg).toBe('none');
    expect(unsigned.signature).toBeNull();
    expect(/^[a-f0-9]{64}$/.test(unsigned.content_sha256)).toBe(true);

    const signed = await signReceipt('secret-key', payload, 'k1');
    expect(signed.signature_alg).toBe('HS256');
    expect(signed.signature).not.toBeNull();
    expect(signed.signing_key_id).toBe('k1');
    // same payload → same content hash regardless of signing
    expect(signed.content_sha256).toBe(unsigned.content_sha256);
  });
});
