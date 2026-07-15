import { describe, expect, it, vi } from 'vitest';
import { finishModelExecutionReceiptRow, startModelExecutionReceiptRow } from '../dal/model-execution-receipt-store';
import { modelLineagePolicy } from '../lib/model-execution-lineage';

function sqlWith(rowsByTransaction: unknown[][]) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let transactionIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = { text: strings.join('?'), values };
    statements.push(statement);
    return statement as never;
  };
  (tag as unknown as { transaction: unknown }).transaction = async (build: (tx: unknown) => unknown[]) => {
    const queries = build(tag);
    const rows = rowsByTransaction[transactionIndex++] ?? [];
    return queries.map((_, index) => index === 0 ? [] : rows);
  };
  return { sql: tag as never, statements };
}

describe('model execution receipt store', () => {
  it('keeps the default-off policy side-effect-free and loads SQL only for strict mode', () => {
    const load = vi.fn(() => sqlWith([]).sql);
    expect(modelLineagePolicy({ load }, {}).required).toBe(false);
    expect(load).not.toHaveBeenCalled();

    const enabled = modelLineagePolicy({ load }, { CONTEXT_PACKET_PERSISTENCE_ENABLED: 'true' });
    expect(enabled.required).toBe(true);
    expect(enabled.factory).toBeTypeOf('function');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('starts only when resolution and context packet share tenant and principal lineage', async () => {
    const { sql, statements } = sqlWith([[{ id: 'mer_1' }]]);
    const id = await startModelExecutionReceiptRow(sql, 'tenant_a', 'user_a', {
      resolution_id: 'rsr_1', context_packet_id: 'cpk_1', action: 'assistant:answer',
      provider: 'workers_ai', model_key: '@cf/meta/llama-3.1-8b-instruct',
    });
    expect(id).toBe('mer_1');
    const insert = statements.find((statement) => statement.text.includes('INSERT INTO model_execution_receipts'))!;
    expect(insert.text).toContain('c.workspace_id = r.workspace_id');
    expect(insert.text).toContain('c.principal_id = r.principal_id');
    expect(insert.values).toContain('tenant_a');
    expect(insert.text).not.toMatch(/prompt|output|message|response/);
  });

  it('finalizes only the tenant-bound started receipt', async () => {
    const { sql, statements } = sqlWith([[{ id: 'mer_1' }]]);
    await finishModelExecutionReceiptRow(sql, 'tenant_a', 'mer_1', {
      status: 'completed', tokens_in: 12, tokens_out: 8, latency_ms: 40, error_code: null,
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE model_execution_receipts'))!;
    expect(update.text).toContain("workspace_id =");
    expect(update.text).toContain("status = 'started'");
    expect(update.values).toContain('tenant_a');
  });
});
