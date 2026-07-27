import { describe, expect, it } from 'vitest';
import { appendChatExchangeRow, listChatHistoryRow } from '../dal/chat-store';

function sqlReturning(rows: Array<Record<string, unknown>>) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ text: strings.join('?'), values });
    return rows;
  };
  return { sql: sql as never, statements };
}

describe('chat authority persistence', () => {
  it('writes the thread and ordered interaction entries in one fail-closed statement', async () => {
    const persisted = [
      {
        id: 41,
        thread_id: 'thr_user1__ws1|project1|',
        role: 'you',
        body: 'Create the launch plan',
        interaction_id: 'interaction_1',
        entry_type: 'user_request',
        created_at: '2026-07-27T00:00:00Z',
      },
      {
        id: 42,
        thread_id: 'thr_user1__ws1|project1|',
        role: 'assistant',
        body: 'Drafted the launch plan',
        interaction_id: 'interaction_1',
        entry_type: 'assistant_answer',
        created_at: '2026-07-27T00:00:01Z',
      },
    ];
    const { sql, statements } = sqlReturning(persisted);

    const result = await appendChatExchangeRow(
      sql,
      'user_1',
      { workspace_id: 'ws_1', project_id: 'project_1' },
      [
        {
          role: 'you',
          body: 'Create the launch plan',
          interaction_id: 'interaction_1',
          entry_type: 'user_request',
        },
        {
          role: 'assistant',
          body: 'Drafted the launch plan',
          generated_by: 'deterministic',
          interaction_id: 'interaction_1',
          entry_type: 'assistant_answer',
        },
      ],
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]!.text).toContain('WITH thread_written AS');
    expect(statements[0]!.text).toContain('jsonb_to_recordset');
    expect(statements[0]!.text).toContain('ORDER BY message.sequence');
    expect(statements[0]!.text).toContain('ON CONFLICT (thread_id, interaction_id, entry_type)');
    expect(statements[0]!.text).toContain('chat_messages.body = EXCLUDED.body');
    expect(statements[0]!.text).toContain('chat_messages.grounded_on IS NOT DISTINCT FROM EXCLUDED.grounded_on');
    expect(result).toMatchObject({
      thread_id: 'thr_user1__ws1|project1|',
      messages: [
        { id: '41', interaction_id: 'interaction_1', entry_type: 'user_request' },
        { id: '42', interaction_id: 'interaction_1', entry_type: 'assistant_answer' },
      ],
    });
  });

  it('fails when the atomic authority statement does not return every requested entry', async () => {
    const { sql } = sqlReturning([]);
    await expect(appendChatExchangeRow(
      sql,
      'user_1',
      { workspace_id: 'ws_1' },
      [{ role: 'you', body: 'Persist me', interaction_id: 'interaction_2', entry_type: 'user_request' }],
    )).rejects.toMatchObject({ code: 'INTERACTION_ID_CONFLICT', status: 409 });
  });

  it('reads the newest bounded history and presents it chronologically', async () => {
    const { sql, statements } = sqlReturning([]);
    await listChatHistoryRow(sql, 'user_1', { workspace_id: 'ws_1' }, 100);

    expect(statements).toHaveLength(1);
    expect(statements[0]!.text).toContain('ORDER BY created_at DESC, id DESC');
    expect(statements[0]!.text).toContain('LIMIT');
    expect(statements[0]!.text).toContain('ORDER BY created_at ASC, id ASC');
  });
});
