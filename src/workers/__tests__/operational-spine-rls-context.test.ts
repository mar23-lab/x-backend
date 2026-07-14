// operational-spine-rls-context.test.ts
//
// Proves the operational spine DAL sets request-scoped Postgres RLS context
// before issuing tenant-scoped queries. This is the required precondition before
// considering FORCE ROW LEVEL SECURITY.

import { describe, expect, it } from 'vitest';
import {
  createApprovalRequestRow,
  createEvidenceItemRow,
  createMetricDeltaRow,
  executeCustomerDataLifecycleRequestRow,
  createTaskPacketRow,
  createToolEventRow,
  listApprovalRequestsRow,
  listEvidenceItemsRow,
  listMetricDeltasRow,
  listTaskPacketsRow,
  listToolEventsRow,
  withWorkspaceRlsContext,
} from '../dal/operational-spine-store';
import type { Sql } from '../db/client';

type CapturedQuery = { text: string; params: unknown[] };
type CapturedTransaction = {
  queries: CapturedQuery[];
  opts?: Record<string, unknown>;
};

function fakeSql(resultSets: unknown[][] = [[{ workspace_context: 'tenant_a' }], []]) {
  const transactions: CapturedTransaction[] = [];
  const tx = (strings: TemplateStringsArray, ...params: unknown[]) => ({
    text: strings.join('$'),
    params,
  });
  const sql = Object.assign(tx, {
    transaction: async (build: (tag: typeof tx) => CapturedQuery[], opts?: Record<string, unknown>) => {
      const queries = build(tx);
      transactions.push({ queries, opts });
      return resultSets;
    },
  }) as unknown as Sql;
  return { sql, transactions };
}

function fakeSqlSequence(resultSetSequence: unknown[][][]) {
  const transactions: CapturedTransaction[] = [];
  let index = 0;
  const tx = (strings: TemplateStringsArray, ...params: unknown[]) => ({
    text: strings.join('$'),
    params,
  });
  const sql = Object.assign(tx, {
    transaction: async (build: (tag: typeof tx) => CapturedQuery[], opts?: Record<string, unknown>) => {
      const queries = build(tx);
      transactions.push({ queries, opts });
      return resultSetSequence[index++] ?? [];
    },
  }) as unknown as Sql;
  return { sql, transactions };
}

describe('operational spine RLS context', () => {
  it('prepends transaction-local xlooop.current_workspace_id before scoped queries', async () => {
    const { sql, transactions } = fakeSql([[{ workspace_context: 'tenant_a' }], [{ id: 'row_1' }]]);

    const [rows] = await withWorkspaceRlsContext<[Array<{ id: string }>]>(sql, 'tenant_a', (txSql) => [
      txSql`SELECT id FROM task_packets WHERE workspace_id = ${'tenant_a'}`,
    ], { readOnly: true });

    expect(rows).toEqual([{ id: 'row_1' }]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.opts).toMatchObject({ isolationLevel: 'ReadCommitted', readOnly: true });
    expect(transactions[0]?.queries[0]?.text).toContain("set_config('xlooop.current_workspace_id'");
    expect(transactions[0]?.queries[0]?.params).toEqual(['tenant_a']);
    expect(transactions[0]?.queries[1]?.text).toContain('SELECT id FROM task_packets');
  });

  it('listTaskPacketsRow runs through the RLS context wrapper', async () => {
    const { sql, transactions } = fakeSql([
      [{ workspace_context: 'tenant_a' }],
      [{
        id: 'pkt_1',
        workspace_id: 'tenant_a',
        title: 'Packet',
        summary: 'Scoped',
        lifecycle_state: 'ready',
        actor_user_id: 'user_op',
        allowed_tools: [],
        forbidden_tools: [],
        source_refs: [],
        evidence_ref_ids: [],
        approval_required: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    ]);

    const rows = await listTaskPacketsRow(sql, 'tenant_a');

    expect(rows).toHaveLength(1);
    expect(transactions[0]?.queries[0]?.text).toContain("set_config('xlooop.current_workspace_id'");
    expect(transactions[0]?.queries[1]?.text).toContain('FROM task_packets');
  });

  it.each([
    {
      name: 'createTaskPacketRow',
      resultSets: [[{ workspace_context: 'tenant_a' }], [{
        id: 'pkt_1',
        workspace_id: 'tenant_a',
        project_id: null,
        event_id: null,
        title: 'Packet',
        summary: 'Scoped',
        lifecycle_state: 'ready',
        actor_user_id: 'user_op',
        allowed_tools: [],
        forbidden_tools: [],
        source_refs: [],
        evidence_ref_ids: [],
        approval_required: true,
        expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }]],
      run: (sql: Sql) => createTaskPacketRow(sql, 'tenant_a', 'user_op', {
        id: 'pkt_1',
        title: 'Packet',
        summary: 'Scoped',
      }),
      query: 'INSERT INTO task_packets',
    },
    {
      name: 'createEvidenceItemRow',
      resultSets: [[{ workspace_context: 'tenant_a' }], [{
        id: 'ev_1',
        workspace_id: 'tenant_a',
        packet_id: null,
        event_id: null,
        kind: 'link',
        title: 'Evidence',
        uri: 'https://example.com',
        content_hash: null,
        summary: null,
        redaction_status: 'metadata_only',
        actor_user_id: 'user_op',
        created_at: new Date().toISOString(),
      }]],
      run: (sql: Sql) => createEvidenceItemRow(sql, 'tenant_a', 'user_op', {
        kind: 'link',
        title: 'Evidence',
        uri: 'https://example.com',
      }),
      query: 'INSERT INTO evidence_items',
    },
    {
      name: 'createApprovalRequestRow',
      resultSets: [[{ workspace_context: 'tenant_a' }], [{
        id: 'apr_1',
        workspace_id: 'tenant_a',
        packet_id: null,
        event_id: null,
        requested_by: 'user_op',
        decided_by: null,
        status: 'requested',
        reason: 'review',
        decision_comment: null,
        requested_at: new Date().toISOString(),
        decided_at: null,
      }]],
      run: (sql: Sql) => createApprovalRequestRow(sql, 'tenant_a', 'user_op', {
        reason: 'review',
      }),
      query: 'INSERT INTO approval_requests',
    },
    {
      name: 'createToolEventRow',
      resultSets: [[{ workspace_context: 'tenant_a' }], [{
        id: 'te_1',
        workspace_id: 'tenant_a',
        packet_id: null,
        tool_name: 'xlooop.report_tool_event',
        action: 'report_tool_event',
        actor_user_id: 'user_op',
        status: 'completed',
        evidence_item_id: null,
        summary: 'reported',
        created_at: new Date().toISOString(),
      }]],
      run: (sql: Sql) => createToolEventRow(sql, 'tenant_a', 'user_op', {
        tool_name: 'xlooop.report_tool_event',
        action: 'report_tool_event',
        status: 'completed',
        summary: 'reported',
      }),
      query: 'INSERT INTO tool_events',
    },
    {
      name: 'createMetricDeltaRow',
      resultSets: [[{ workspace_context: 'tenant_a' }], [{
        id: 'md_1',
        workspace_id: 'tenant_a',
        packet_id: null,
        metric_id: 'production.coherence',
        before_value: 1,
        after_value: 2,
        delta_value: 1,
        evidence_item_id: null,
        recorded_by: 'user_op',
        recorded_at: new Date().toISOString(),
      }]],
      run: (sql: Sql) => createMetricDeltaRow(sql, 'tenant_a', 'user_op', {
        metric_id: 'production.coherence',
        before_value: 1,
        after_value: 2,
      }),
      query: 'INSERT INTO metric_deltas',
    },
    {
      name: 'listEvidenceItemsRow',
      resultSets: [[{ workspace_context: 'tenant_a' }], []],
      run: (sql: Sql) => listEvidenceItemsRow(sql, 'tenant_a'),
      query: 'FROM evidence_items',
    },
    {
      name: 'listApprovalRequestsRow',
      resultSets: [[{ workspace_context: 'tenant_a' }], []],
      run: (sql: Sql) => listApprovalRequestsRow(sql, 'tenant_a'),
      query: 'FROM approval_requests',
    },
    {
      name: 'listToolEventsRow',
      resultSets: [[{ workspace_context: 'tenant_a' }], []],
      run: (sql: Sql) => listToolEventsRow(sql, 'tenant_a'),
      query: 'FROM tool_events',
    },
    {
      name: 'listMetricDeltasRow',
      resultSets: [[{ workspace_context: 'tenant_a' }], []],
      run: (sql: Sql) => listMetricDeltasRow(sql, 'tenant_a'),
      query: 'FROM metric_deltas',
    },
  ])('$name runs through the RLS context wrapper', async ({ resultSets, run, query }) => {
    const { sql, transactions } = fakeSql(resultSets);
    await run(sql);
    expect(transactions.length).toBeGreaterThanOrEqual(1);
    for (const transaction of transactions) {
      expect(transaction.queries[0]?.text).toContain("set_config('xlooop.current_workspace_id'");
      expect(transaction.queries[0]?.params).toEqual(['tenant_a']);
    }
    expect(transactions.at(-1)?.queries.some((captured) => captured.text.includes(query))).toBe(true);
  });

  it('executeCustomerDataLifecycleRequestRow runs packet check and execution through RLS context', async () => {
    const { sql, transactions } = fakeSqlSequence([
      [[{ workspace_context: 'tenant_a' }], [{ id: 'pkt_1' }]],
      [
        [{ workspace_context: 'tenant_a' }],
        [{ id: 'apr_1' }],
        [{ id: 'pkt_1' }],
        [{
          id: 'ev_receipt',
          workspace_id: 'tenant_a',
          packet_id: 'pkt_1',
          event_id: null,
          kind: 'receipt',
          title: 'Customer data delete execution receipt',
          uri: 'xlooop://customer-data/delete-receipts/apr_1',
          content_hash: null,
          summary: 'receipt',
          redaction_status: 'metadata_only',
          actor_user_id: 'user_op',
          created_at: new Date().toISOString(),
        }],
        [{
          id: 'te_receipt',
          workspace_id: 'tenant_a',
          packet_id: 'pkt_1',
          tool_name: 'xlooop.customer_data_lifecycle',
          action: 'report_tool_event',
          actor_user_id: 'user_op',
          status: 'completed',
          evidence_item_id: 'ev_receipt',
          summary: 'done',
          created_at: new Date().toISOString(),
        }],
      ],
    ]);

    const result = await executeCustomerDataLifecycleRequestRow(sql, 'tenant_a', 'user_op', {
      approval_id: 'apr_1',
      request_kind: 'delete',
      target_packet_id: 'pkt_1',
    });

    expect(result.archived_packet_ids).toEqual(['pkt_1']);
    expect(transactions).toHaveLength(2);
    for (const transaction of transactions) {
      expect(transaction.queries[0]?.text).toContain("set_config('xlooop.current_workspace_id'");
      expect(transaction.queries[0]?.params).toEqual(['tenant_a']);
    }
    expect(transactions[1]?.queries.some((captured) => captured.text.includes('UPDATE task_packets'))).toBe(true);
    expect(transactions[1]?.queries.some((captured) => captured.text.includes('INSERT INTO evidence_items'))).toBe(true);
    expect(transactions[1]?.queries.some((captured) => captured.text.includes('INSERT INTO tool_events'))).toBe(true);
  });
});
