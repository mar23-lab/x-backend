import { describe, expect, it } from 'vitest';
import { countGovernedExecutionReceiptsRow, executeIntakeResolutionRow } from '../dal/intake-store';

const RESOLUTION = {
  id: 'inr_1', workspace_id: 'ws_1', actor_user_id: 'user_1', project_id: 'proj_1',
  client_request_id: 'resolve_1', request_digest: 'a'.repeat(64), operation: 'create_work',
  confidence: 0.99, ambiguity: false, target: { type: 'task_packet', id: null, label: 'Launch' },
  effect_summary: 'Create launch packet', risk: 'medium', authority: { allowed: true, safe_reason: 'operator' },
  context_summary: { reference_count: 0, source_count: 0, evidence_count: 0 }, required_tools: [],
  requires_confirmation: true, next_step: 'confirm', action_payload: { title: 'Launch', project_id: 'proj_1' },
  current_work_version: 0, version: 1, status: 'consumed', expires_at: '2099-01-01T00:00:00Z',
  consumed_at: '2026-07-15T00:00:00Z', created_at: '2026-07-15T00:00:00Z',
};

const EXECUTION_ROW = {
  ...RESOLUTION,
  receipt_id: 'ger_1', receipt_client_request_id: 'execute_1',
  receipt_target_type: 'task_packet', receipt_target_id: 'pkt_1', receipt_created_at: '2026-07-15T00:00:01Z',
};

function sqlWith(transactionRows: unknown[][]) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let transactionIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = { text: strings.join('?'), values };
    statements.push(statement);
    return statement as never;
  };
  (tag as unknown as { transaction: unknown }).transaction = async (build: (tx: unknown) => unknown[]) => {
    const queries = build(tag);
    const rows = transactionRows[transactionIndex++] ?? [];
    return queries.map((_, index) => index === 0 ? [] : rows);
  };
  return { sql: tag as never, statements };
}

describe('single-intake transactional execution', () => {
  it('counts receipts through the tenant RLS context without returning receipt data', async () => {
    const { sql, statements } = sqlWith([[{ receipt_count: '3' }]]);
    const count = await countGovernedExecutionReceiptsRow(sql, 'ws_1');
    expect(count).toBe(3);
    const query = statements.find((statement) => statement.text.includes('governed_execution_receipts'))!;
    expect(query.text).toContain('WHERE workspace_id =');
    expect(query.values).toContain('ws_1');
  });

  it('binds project validation and the execution idempotency key into the atomic write', async () => {
    const { sql, statements } = sqlWith([[EXECUTION_ROW]]);
    const result = await executeIntakeResolutionRow(sql, 'ws_1', 'user_1', 'inr_1', 1, 0, 'execute_1');
    expect(result).toMatchObject({ ok: true, packet_id: 'pkt_1', receipt: { client_request_id: 'execute_1' } });
    const write = statements.find((statement) => statement.text.includes('WITH claimed AS'))!;
    expect(write.text).toContain("p.workspace_id = intake_resolutions.workspace_id");
    expect(write.text).toContain("p.status <> 'archived'");
    expect(write.text).toContain('client_request_id');
    expect(write.values).toContain('execute_1');
  });

  it('replays the original receipt for the same execution idempotency key', async () => {
    const { sql } = sqlWith([[], [EXECUTION_ROW]]);
    const result = await executeIntakeResolutionRow(sql, 'ws_1', 'user_1', 'inr_1', 1, 0, 'execute_1');
    expect(result).toMatchObject({ ok: true, replayed: true, packet_id: 'pkt_1', receipt: { id: 'ger_1' } });
  });

  it('does not replay a consumed resolution for a different execution key', async () => {
    const { sql } = sqlWith([[], [EXECUTION_ROW]]);
    const result = await executeIntakeResolutionRow(sql, 'ws_1', 'user_1', 'inr_1', 1, 0, 'execute_other');
    expect(result).toEqual({ ok: false, reason: 'already_consumed' });
  });
});
