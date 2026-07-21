import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  foldSignalsIntoProfile,
  PERSONALIZATION_FORBIDDEN_KEYS,
  type LearningSignalForFold,
} from '../lib/personalization-fold';

const sig = (over: Partial<LearningSignalForFold>): LearningSignalForFold => ({
  id: 's1', signal_kind: 'preference', signal_json: {}, created_at: '2026-07-21T00:00:00.000Z', ...over,
});

describe('foldSignalsIntoProfile — Y-wave MATERIALIZE (ADR-XB-012)', () => {
  it('routes each signal_kind to its bucket', () => {
    const p = foldSignalsIntoProfile([
      sig({ id: 'a', signal_kind: 'preference', signal_json: { tone: 'concise' } }),
      sig({ id: 'b', signal_kind: 'personal_rule', signal_json: { always: 'cite sources' } }),
      sig({ id: 'c', signal_kind: 'personal_skill', signal_json: { governed_shipping: true } }),
      sig({ id: 'd', signal_kind: 'workflow_default', signal_json: { review: 'weekly' } }),
      sig({ id: 'e', signal_kind: 'correction', signal_json: { fixed: 1 } }),
    ]);
    expect(p.preference_json).toEqual({ tone: 'concise' });
    expect(p.personal_rules_json).toEqual({ always: 'cite sources' });
    expect(p.personal_skills_json).toEqual({ governed_shipping: true });
    expect(p.learned_defaults_json).toEqual({ review: 'weekly', fixed: 1 }); // workflow_default + correction both land here
    expect(p.source_signal_ids).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('last-write-wins on the same key, ordered by created_at', () => {
    const p = foldSignalsIntoProfile([
      sig({ id: 'late', signal_kind: 'preference', signal_json: { tone: 'formal' }, created_at: '2026-07-21T02:00:00.000Z' }),
      sig({ id: 'early', signal_kind: 'preference', signal_json: { tone: 'concise' }, created_at: '2026-07-21T01:00:00.000Z' }),
    ]);
    expect(p.preference_json.tone).toBe('formal'); // the later signal wins regardless of input order
    expect(p.source_signal_ids).toEqual(['early', 'late']); // lineage carries both, in time order
  });

  it('is order-independent (idempotent as a function of the SET)', () => {
    const s = [
      sig({ id: 'a', signal_kind: 'preference', signal_json: { x: 1 }, created_at: '2026-07-21T01:00:00.000Z' }),
      sig({ id: 'b', signal_kind: 'preference', signal_json: { y: 2 }, created_at: '2026-07-21T02:00:00.000Z' }),
    ];
    expect(foldSignalsIntoProfile(s)).toEqual(foldSignalsIntoProfile([...s].reverse()));
  });

  it('strips FORBIDDEN_OVERRIDE_KEYS from every bucket (defense-in-depth)', () => {
    const p = foldSignalsIntoProfile([
      sig({ id: 'x', signal_kind: 'preference', signal_json: { tone: 'concise', security: 'off', retention: '0d' } }),
      sig({ id: 'y', signal_kind: 'personal_rule', signal_json: { tenant_isolation: 'disabled', ok: true } }),
    ]);
    expect(p.preference_json).toEqual({ tone: 'concise' }); // security + retention stripped
    expect(p.personal_rules_json).toEqual({ ok: true }); // tenant_isolation stripped
  });

  it('empty signal set ⇒ empty buckets (inert)', () => {
    const p = foldSignalsIntoProfile([]);
    expect(p.preference_json).toEqual({});
    expect(p.learned_defaults_json).toEqual({});
    expect(p.source_signal_ids).toEqual([]);
  });

  it('the local forbidden-key list mirrors the store-side FORBIDDEN_OVERRIDE_KEYS (parity)', () => {
    const store = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../dal/template-policy-store.ts'), 'utf8');
    const block = store.slice(store.indexOf('FORBIDDEN_OVERRIDE_KEYS'));
    for (const k of PERSONALIZATION_FORBIDDEN_KEYS) {
      expect(block).toContain(`'${k}'`); // every fold-side key exists on the store side
    }
  });
});
