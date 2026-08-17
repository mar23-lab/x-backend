import { describe, expect, it } from 'vitest';
import { getCurrentWorkCompositeRow } from '../dal/current-work-store';

type Statement = { text: string; values: unknown[] };

function mockSql(projectionRows: unknown[]) {
  const statements: Statement[] = [];
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = { text: strings.join('?'), values };
    statements.push(statement);
    return statement as never;
  }) as never;
  (tag as unknown as { transaction: unknown }).transaction = async (
    build: (tx: never) => unknown[],
  ) => build(tag).map((query) => {
    const text = (query as Statement).text;
    if (text.includes('WITH visible_events AS')) return projectionRows;
    return [{ workspace_context: 'ws_1' }];
  });
  return { sql: tag, statements };
}

describe('current-work composite store', () => {
  it('maps event-and-packet aggregate counts and a packet focus without losing numeric precision', async () => {
    const { sql } = mockSql([{
      needs_you: '2', blocked: '1', done: '7', total: '12',
      source_watermark: '2026-08-18T00:00:00.000Z',
      id: 'pkt_1', object_type: 'packet', project_id: 'proj_1', intent_id: null,
      title: 'Review the customer brief', state: 'needs_review',
      updated_at: '2026-08-18T00:00:00.000Z',
    }]);

    const projection = await getCurrentWorkCompositeRow(sql, 'ws_1', {
      role: 'owner', project_id: 'proj_1',
    });

    expect(projection.counts).toEqual({ needs_you: 2, blocked: 1, done: 7, total: 12 });
    expect(projection.focus).toEqual({
      id: 'pkt_1', object_type: 'packet', project_id: 'proj_1', intent_id: null,
      title: 'Review the customer brief', state: 'needs_review',
      updated_at: '2026-08-18T00:00:00.000Z',
    });
    expect(projection.source_watermark).toBe('2026-08-18T00:00:00.000Z');
  });

  it('keeps the composite denominator, visibility, project scope, and both packet de-duplication paths in one RLS query', async () => {
    const { sql, statements } = mockSql([]);
    await getCurrentWorkCompositeRow(sql, 'ws_1', { role: 'client', project_id: 'proj_1' });

    const query = statements.find((statement) => statement.text.includes('WITH visible_events AS'))!;
    expect(query.text).toContain('FROM operation_events e');
    expect(query.text).toContain('FROM task_packets p');
    expect(query.text).toContain('UNION ALL');
    expect(query.text).toContain('event_item.id = p.event_id');
    expect(query.text).toContain('receipt.operation_event_id');
    expect(query.text).toContain("receipt.target_type = 'task_packet'");
    expect(query.text).toContain('e.visibility = ANY');
    expect(query.text).toContain('e.project_id IS NULL');
    expect(query.text).toContain('p.project_id IS NULL');
    expect(query.values).toContain('ws_1');
    expect(query.values).toContain('proj_1');
    expect(query.values).toContainEqual(['public_safe']);
  });

  it('returns an honest empty projection when no work exists', async () => {
    const { sql } = mockSql([{
      needs_you: 0, blocked: 0, done: 0, total: 0,
      source_watermark: null, id: null, object_type: null, project_id: null,
      intent_id: null, title: null, state: null, updated_at: null,
    }]);
    await expect(getCurrentWorkCompositeRow(sql, 'ws_1', { role: 'viewer' })).resolves.toEqual({
      counts: { needs_you: 0, blocked: 0, done: 0, total: 0 },
      focus: null,
      source_watermark: null,
    });
  });
});
