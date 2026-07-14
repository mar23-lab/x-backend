// intent-edit.test.ts · 2026-06-12 · OS-5 W4 (intents become editable)
//
// updateIntentFieldsForOperatorRow: UPDATE the mutable intents row + APPEND the audit receipt
// naming the prior title (the repoint pattern). Fail-closed for foreign intents.

import { describe, it, expect } from 'vitest';
import { updateIntentFieldsForOperatorRow } from '../dal/intent-store';

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
const INTENT_ROW = {
  id: 'intent-1', workspace_id: 'ws1', project_id: null, domain_id: null,
  title: 'Fixed title', summary: 'new summary', status: 'open',
  owner_user_id: 'user_op', derived_from: null, origin: 'operator',
  created_at: '2026-06-12T00:00:00Z', updated_at: '2026-06-12T01:00:00Z',
};

describe('OS-5 W4 · updateIntentFieldsForOperatorRow', () => {
  it('updates title+summary and APPENDS a receipt naming the prior title', async () => {
    const { sql, calls } = makeSql([
      [{ id: 'ws1' }],                                                          // operator workspaces
      [{ id: 'intent-1', title: 'Typo titel', summary: 'old', workspace_id: 'ws1' }], // prior
      [INTENT_ROW],                                                             // UPDATE returning
      [],                                                                       // receipt INSERT
    ]);
    const out = await updateIntentFieldsForOperatorRow(sql, OWNER, 'intent-1', { title: 'Fixed title', summary: 'new summary' });
    expect(out).not.toBeNull();
    expect(out!.title).toBe('Fixed title');
    // the UPDATE touches the intents table (mutable artefact), not operation_events content
    expect(calls[2]!.text).toContain('UPDATE intents SET');
    // the receipt is an APPENDED event linked to the intent, with honest provenance
    const receipt = calls[3]!;
    expect(receipt.text).toContain('INSERT INTO operation_events');
    expect(receipt.values.join(' ')).toContain('intent-1');
    expect(receipt.values.join(' ')).toContain('title was: Typo titel');
    expect(String(receipt.values[0])).toMatch(/^evt_intent_edited_intent-1_/);
  });

  it('fail-closed: foreign intent -> null, nothing written', async () => {
    const { sql, calls } = makeSql([
      [{ id: 'ws1' }],
      [],               // prior lookup finds nothing in operator workspaces
    ]);
    const out = await updateIntentFieldsForOperatorRow(sql, OWNER, 'intent-x', { title: 'X' });
    expect(out).toBeNull();
    expect(calls.length).toBe(2); // no UPDATE, no receipt
  });

  it('rejects an empty patch and an empty title', async () => {
    const { sql, calls } = makeSql([]);
    expect(await updateIntentFieldsForOperatorRow(sql, OWNER, 'intent-1', {})).toBeNull();
    expect(await updateIntentFieldsForOperatorRow(sql, OWNER, 'intent-1', { title: '   ' })).toBeNull();
    expect(calls.length).toBe(0); // bails before any SQL
  });
});
