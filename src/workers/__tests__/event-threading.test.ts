// event-threading.test.ts · 2026-06-12 · OS-4 P1 (comments-as-events, migration 032)
//
// The malfunction this guards: operator-capture sent parent_event_id; the DAL's explicit INSERT
// column list silently dropped it (every threaded reply since 2026-06-09 lost its parent link).
// Asserts, against a mocked sql tag:
//   1. upsertEventRow PERSISTS parent_event_id (the INSERT carries the value).
//   2. listEventsRow / listEventsForOperatorRow accept the opt-in thread filters and SELECT the
//      column; absent filters keep prior call shapes (defaults unchanged).
//   3. normalizeEventRow nulls an absent parent_event_id (round-trip shape stability).

import { describe, it, expect, vi } from 'vitest';
import { upsertEventRow, listEventsRow, listEventsForOperatorRow } from '../dal/event-store';

// A minimal sql tag double: records every (strings, values) call; returns scripted results in order.
// Also supports `.transaction(build, opts)` so reads wrapped in withWorkspaceRlsContext (043,
// operation_events RLS) work: the build fn records its tx-tag calls into the SAME `calls` array, and
// the transaction returns [set_config-result, ...results] so withWorkspaceRlsContext's `slice(1)`
// hands the SELECT its scripted rows. Direct sql`` calls (e.g. upsertEventRow) are unchanged.
function makeSql(results: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let i = 0;
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(results[i++] ?? []);
  }) as never;
  const sql = Object.assign(tag, {
    transaction: async (build: (tx: never) => unknown[], _opts?: Record<string, unknown>) => {
      const txTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join('?'), values });
        return { text: strings.join('?'), values };
      }) as never;
      build(txTag); // records the set_config + SELECT calls
      return [[{ workspace_context: 'ws' }], ...results];
    },
  }) as never;
  return { sql, calls };
}

// The tenant SELECT is the query touching operation_events (calls[0] is now the set_config GUC line).
const selectCall = (calls: Array<{ text: string; values: unknown[] }>) =>
  calls.find((c) => c.text.includes('operation_events'))!;

describe('OS-4 P1 · event threading (parent_event_id)', () => {
  it('upsertEventRow PERSISTS parent_event_id (the FIX#3 silent drop is closed)', async () => {
    const { sql, calls } = makeSql([[], []]); // existence check -> empty; insert -> ok
    await upsertEventRow(sql, 'ws1', {
      id: 'cmt-1', source_tool: 'operator', status: 'completed',
      summary: 'a threaded reply', occurred_at: '2026-06-12T00:00:00Z',
      parent_event_id: 'evt-parent-9',
    });
    const insert = calls[1]!;
    expect(insert.text).toContain('parent_event_id');
    expect(insert.values).toContain('evt-parent-9');
  });

  it('upsertEventRow without a parent inserts NULL (prior shape preserved)', async () => {
    const { sql, calls } = makeSql([[], []]);
    await upsertEventRow(sql, 'ws1', {
      id: 'evt-2', source_tool: 'operator', status: 'queued',
      summary: 'broadcast', occurred_at: '2026-06-12T00:00:00Z',
    });
    const insert = calls[1]!;
    expect(insert.text).toContain('parent_event_id');
    expect(insert.values[insert.values.length - 1]).toBeNull();
  });

  it('listEventsRow thread-fetch: parent_event_id filter binds + column selected', async () => {
    const { sql, calls } = makeSql([[]]);
    await listEventsRow(sql, 'ws1', { role: 'operator', parent_event_id: 'evt-parent-9' });
    const q = selectCall(calls);
    expect(q.text).toContain('parent_event_id');
    expect(q.values).toContain('evt-parent-9');
  });

  it('listEventsRow top_level roll-up: parent_event_id IS NULL predicate active', async () => {
    const { sql, calls } = makeSql([[]]);
    await listEventsRow(sql, 'ws1', { role: 'operator', top_level: true });
    const q = selectCall(calls);
    expect(q.text).toContain('parent_event_id IS NULL');
    expect(q.values).toContain(true); // the topLevelOnly boolean bind
  });

  it('listEventsRow DEFAULTS unchanged: no thread filter binds when opts omit them', async () => {
    const { sql, calls } = makeSql([[]]);
    await listEventsRow(sql, 'ws1', { role: 'operator' });
    const q = selectCall(calls);
    // The parent filter binds null + topLevelOnly binds false — both predicates inert.
    expect(q.values).toContain(null);
    expect(q.values).toContain(false);
  });

  it('listEventsForOperatorRow (the cockpit path) selects + filters parent_event_id', async () => {
    const { sql, calls } = makeSql([[{ id: 'ws1' }], []]); // workspace lookup, then events
    await listEventsForOperatorRow(sql, ['user_op'], { role: 'operator', parent_event_id: 'evt-parent-9' });
    const q = calls[1]!;
    expect(q.text).toContain('parent_event_id');
    expect(q.values).toContain('evt-parent-9');
  });

  it('normalizeEventRow round-trip: absent parent_event_id surfaces as null', async () => {
    const row = {
      id: 'e1', workspace_id: 'ws1', project_id: null, source_tool: 'operator', agent_id: null,
      intent_id: null, status: 'completed', summary: 's', body: null, evidence_link: null,
      visibility: 'internal_workspace', permission_scope: null, risk: null, approval_state: null,
      next_action: null, occurred_at: '2026-06-12T00:00:00Z',
    };
    const { sql } = makeSql([[row]]);
    const page = await listEventsRow(sql, 'ws1', { role: 'operator' });
    expect(page.events[0]!.parent_event_id).toBeNull();
  });
});
