import { describe, expect, it } from 'vitest';
import { createCurrentWorkParityObservationRow } from '../dal/current-work-parity-store';

describe('current-work parity store', () => {
  it('binds every append to the tenant RLS context and stores no raw content', async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = { text: strings.join('?'), values };
      statements.push(statement);
      return statement as never;
    };
    (tag as unknown as { transaction: unknown }).transaction = async (build: (tx: unknown) => unknown[]) => {
      const queries = build(tag);
      return queries.map((_, index) => index === 0 ? [] : [{ id: 'cwp_1', created_at: '2026-07-15T00:00:00Z' }]);
    };
    const result = await createCurrentWorkParityObservationRow(tag as never, 'tenant_a', 'user_a', {
      server_projection_version: 2,
      client_projection_version: 1,
      server_current_work_version: 'server-v2',
      client_current_work_version: 'client-v1',
      parity_status: 'mismatch',
      difference_codes: ['counts_mismatch'],
      server_state_sha256: 'a'.repeat(64),
      client_state_sha256: 'b'.repeat(64),
      server_item_count: 3,
      client_item_count: 2,
    });
    expect(result.id).toBe('cwp_1');
    const insert = statements.find((statement) => statement.text.includes('current_work_parity_observations'))!;
    expect(insert.values).toContain('tenant_a');
    expect(insert.values).toContain('user_a');
    expect(insert.text).not.toMatch(/title|prompt|evidence|focus_id/);
  });
});
