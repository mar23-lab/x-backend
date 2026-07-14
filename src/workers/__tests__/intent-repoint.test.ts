// intent-repoint.test.ts · 2026-06-12 · OS-4 P3 (attach-event-to-intent)
//
// The L1 re-point + ia-001 audit receipt, against a mocked sql tag. Asserts:
//   1. happy path: intent verified -> prior captured -> intent_id UPDATEd -> receipt INSERTed
//      (threaded under the event via parent_event_id + linked to the intent via intent_id).
//   2. fail-closed: foreign intent (not in operator workspaces) -> null, NO update, NO receipt.
//   3. fail-closed: foreign/missing event -> null, NO update.

import { describe, it, expect } from 'vitest';
import { repointEventIntentForOperatorRow } from '../dal/intent-store';

function makeSql(results: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let i = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(results[i++] ?? []);
  }) as never;
  return { sql, calls };
}

const OWNER = ['user_op'];

describe('OS-4 P3 · repointEventIntentForOperatorRow', () => {
  it('re-points intent_id + appends the audit receipt (threaded + intent-linked)', async () => {
    const { sql, calls } = makeSql([
      [{ id: 'ws1' }],                                   // operator workspaces
      [{ id: 'intent-1', title: 'Ship the fix' }],        // intent exists + owned
      [{ intent_id: 'intent-old', workspace_id: 'ws1' }], // prior pointer
      [{ id: 'evt-9' }],                                  // UPDATE returned a row
      [],                                                 // receipt INSERT
    ]);
    const out = await repointEventIntentForOperatorRow(sql, OWNER, 'intent-1', 'evt-9');
    expect(out).not.toBeNull();
    expect(out!.event_id).toBe('evt-9');
    expect(out!.intent_id).toBe('intent-1');
    expect(out!.prior_intent_id).toBe('intent-old');
    expect(out!.receipt_event_id).toMatch(/^evt_repoint_evt-9_/);
    // the UPDATE touches ONLY intent_id (L1 pointer; ia-001: never content)
    const update = calls[3]!;
    expect(update.text).toContain('UPDATE operation_events SET intent_id =');
    expect(update.text).not.toMatch(/SET[\s\S]*summary|SET[\s\S]*body/);
    // the receipt is an APPENDED event: threaded under evt-9 + linked to intent-1
    const receipt = calls[4]!;
    expect(receipt.text).toContain('INSERT INTO operation_events');
    expect(receipt.text).toContain('parent_event_id');
    expect(receipt.values).toContain('evt-9');     // thread parent
    expect(receipt.values).toContain('intent-1');  // lineage link
    expect(receipt.values.join(' ')).toContain('was: intent-old'); // honest provenance
  });

  it('fail-closed: foreign intent -> null, nothing written', async () => {
    const { sql, calls } = makeSql([
      [{ id: 'ws1' }],
      [],               // intent not found in operator workspaces
    ]);
    const out = await repointEventIntentForOperatorRow(sql, OWNER, 'intent-x', 'evt-9');
    expect(out).toBeNull();
    expect(calls.length).toBe(2); // no UPDATE, no receipt
  });

  it('fail-closed: foreign/missing event -> null, no UPDATE', async () => {
    const { sql, calls } = makeSql([
      [{ id: 'ws1' }],
      [{ id: 'intent-1', title: 'Ship the fix' }],
      [],               // event not found in operator workspaces
    ]);
    const out = await repointEventIntentForOperatorRow(sql, OWNER, 'intent-1', 'evt-foreign');
    expect(out).toBeNull();
    expect(calls.length).toBe(3);
  });
});
