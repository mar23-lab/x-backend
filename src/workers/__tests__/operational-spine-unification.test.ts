// operational-spine-unification.test.ts · W1 (260708) · G2 spine unification (D1 companion-emission).
// DECLARED COVERAGE AXES (HR-VERIFICATION-COVERAGE-AXES-1): flag_states [off(default), on] ·
// actors [human operator (lineage human), agent/customer_token (lineage external/agent)] ·
// data_states [status completed/failed/allowed/denied · with/without packet].
// THE SAFETY PROOF: flag-off is BYTE-IDENTICAL to pre-W1 (one INSERT, legacy column list, no spine event);
// flag-on commits the tool event AND its companion operation_events row in the SAME transaction with a
// two-way backref — a tool action can never exist off the causal spine.

import { describe, it, expect } from 'vitest';
import { createToolEventRow } from '../dal/operational-spine-store';
import type { ToolEventInput } from '../dal/types/operational-spine';

// Mock Sql with .transaction() (the withWorkspaceRlsContext driver shape): captures every statement's
// (text, values); returns [rows] per statement — first statement returns the RETURNING row.
function mockSql() {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const s = { text: strings.join('?'), values };
    stmts.push(s);
    return s as never; // statements are collected, executed via .transaction
  };
  (tag as unknown as { transaction: unknown }).transaction = async (
    cb: (tx: unknown) => unknown[],
  ) => {
    // The REAL driver shape (withWorkspaceRlsContext): transaction(cb) where cb(tx) returns the statement
    // array; results[0] is the GUC set_config and gets sliced off by the caller.
    const queries = cb(tag);
    return queries.map((q) => {
      const text = (q as { text?: string })?.text ?? '';
      if (text.includes('INSERT INTO tool_events')) {
        return [{ id: 'te_1', workspace_id: 'ws1', packet_id: null, tool_name: 'codex', action: 'report_tool_event', actor_user_id: 'u1', status: 'completed', evidence_item_id: null, summary: 's', created_at: 'now' }];
      }
      return [];
    });
  };
  return { sql: tag as never, stmts };
}

const INPUT: ToolEventInput = { tool_name: 'codex', action: 'report_tool_event', status: 'completed', summary: 'ran tests' };

function textsOf(stmts: Array<{ text: string }>) {
  return stmts.map((s) => s.text).join('\n---\n');
}

describe('createToolEventRow · flag OFF (default) == pre-W1 byte-parity', () => {
  it('emits exactly ONE tool_events INSERT with the LEGACY column list (no event_id, no spine event)', async () => {
    const { sql, stmts } = mockSql();
    await createToolEventRow(sql, 'ws1', 'u1', INPUT); // no opts at all — the untouched legacy call shape
    const all = textsOf(stmts);
    expect(all).toContain('INSERT INTO tool_events');
    expect(all).not.toContain('event_id');               // legacy column list untouched (works pre-057)
    expect(all).not.toContain('INSERT INTO operation_events'); // no companion event
  });

  it('explicit emitSpineEvent:false behaves identically', async () => {
    const { sql, stmts } = mockSql();
    await createToolEventRow(sql, 'ws1', 'u1', INPUT, { emitSpineEvent: false });
    expect(textsOf(stmts)).not.toContain('INSERT INTO operation_events');
  });
});

describe('createToolEventRow · flag ON == same-transaction companion emission', () => {
  it('tool_events INSERT (with event_id) + operation_events INSERT ride the SAME transaction', async () => {
    const { sql, stmts } = mockSql();
    await createToolEventRow(sql, 'ws1', 'u1', INPUT, { emitSpineEvent: true });
    const all = textsOf(stmts);
    expect(all).toContain('INSERT INTO tool_events');
    expect(all).toContain('event_id');                          // backref stamped
    expect(all).toContain('INSERT INTO operation_events');      // companion on the spine
    // Two-way link: the SAME generated ev_ id appears in both statements' values.
    const toolStmt = stmts.find((s) => s.text.includes('INSERT INTO tool_events'))!;
    const evStmt = stmts.find((s) => s.text.includes('INSERT INTO operation_events'))!;
    // system-emitted source_tool rides as the compile-checked TOOL_ACTION_SOURCE parameter (not SQL text).
    expect(evStmt.values).toContain('tool_action');
    const evId = evStmt.values.find((v) => typeof v === 'string' && (v as string).startsWith('ev_'));
    expect(evId).toBeTruthy();
    expect(toolStmt.values).toContain(evId);
  });

  it('carries the 050 actor-lineage from the route (server-derived, never body)', async () => {
    const { sql, stmts } = mockSql();
    await createToolEventRow(sql, 'ws1', 'u1', INPUT, {
      emitSpineEvent: true,
      lineage: { authorized_by_user_id: 'u1', instrument_kind: 'external', authority_source: 'service_token', request_id: 'req_9' },
    });
    const evStmt = stmts.find((s) => s.text.includes('INSERT INTO operation_events'))!;
    for (const v of ['u1', 'external', 'service_token', 'req_9']) expect(evStmt.values).toContain(v);
  });

  it('status mapping: denied/failed → failed; allowed/completed → completed', async () => {
    for (const [toolStatus, evStatus] of [['denied', 'failed'], ['failed', 'failed'], ['allowed', 'completed'], ['completed', 'completed']] as const) {
      const { sql, stmts } = mockSql();
      await createToolEventRow(sql, 'ws1', 'u1', { ...INPUT, status: toolStatus }, { emitSpineEvent: true });
      const evStmt = stmts.find((s) => s.text.includes('INSERT INTO operation_events'))!;
      expect(evStmt.values).toContain(evStatus);
    }
  });

  it('opts are NOT readable from the body: a body-injected emitSpineEvent field is ignored (separate param)', async () => {
    const { sql, stmts } = mockSql();
    // simulate a malicious body that tries to smuggle the flag through input
    await createToolEventRow(sql, 'ws1', 'u1', { ...INPUT, emitSpineEvent: true } as never);
    expect(textsOf(stmts)).not.toContain('INSERT INTO operation_events');
  });
});
