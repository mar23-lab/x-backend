import { describe, expect, it } from 'vitest';
import { beginProjectionOutboxAttempt, claimProjectionOutboxRows } from '../dal/projection-outbox-store';

function sqlReturning(rows: unknown[]) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ text: strings.join('?'), values });
    return Promise.resolve(rows);
  };
  return { sql: sql as never, statements };
}

describe('projection outbox SQL boundaries', () => {
  it('claims a bounded cross-tenant dispatch batch with skip-locked concurrency', async () => {
    const { sql, statements } = sqlReturning([]);
    await claimProjectionOutboxRows(sql, 500, '2026-07-15T00:00:00Z', '2026-07-14T23:55:00Z');
    expect(statements[0].text).toContain('FOR UPDATE SKIP LOCKED');
    expect(statements[0].text).toContain("status = 'pending'");
    expect(statements[0].values).toContain(100);
  });

  it('requires both workspace and outbox id before a consumer attempt can mutate state', async () => {
    const { sql, statements } = sqlReturning([]);
    await beginProjectionOutboxAttempt(sql, 'ws_a', 'out_a', '2026-07-15T00:00:00Z');
    expect(statements[0].text).toContain('workspace_id =');
    expect(statements[0].text).toContain('id =');
    expect(statements[0].values).toContain('ws_a');
    expect(statements[0].values).toContain('out_a');
  });
});
