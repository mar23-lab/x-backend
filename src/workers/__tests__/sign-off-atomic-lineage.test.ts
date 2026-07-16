import { describe, expect, it, vi } from 'vitest';
import { createSignOffRow } from '../dal/governance-store';

describe('sign-off atomic lineage', () => {
  it('writes sign-off, target state, operation event and audit log in one statement', async () => {
    const statements: string[] = [];
    const sql = vi.fn((parts: TemplateStringsArray) => {
      const text = parts.join('?');
      statements.push(text);
      if (text.includes('SELECT id FROM operation_events')) return Promise.resolve([{ id: 'evt-1' }]);
      return Promise.resolve([{
        id: 7,
        audit_event_id: 'evt_signoff_7',
        workspace_id: 'ws-1',
        event_id: 'evt-1',
        user_id: 'user-1',
        verdict: 'approved',
        comment: null,
        signed_at: '2026-07-15T00:00:00.000Z',
      }]);
    });

    const row = await createSignOffRow(sql as never, 'ws-1', 'user-1', {
      event_id: 'evt-1', verdict: 'approved', decision_kind: 'approval',
    }, 'req-1');

    expect(row.audit_event_id).toBe('evt_signoff_7');
    expect(statements).toHaveLength(2);
    const authorityStatement = statements[1];
    expect(authorityStatement).toContain('INSERT INTO sign_offs');
    expect(authorityStatement).toContain('UPDATE operation_events');
    expect(authorityStatement).toContain('INSERT INTO operation_events');
    expect(authorityStatement).toContain('INSERT INTO audit_logs');
    expect(authorityStatement).toContain('FROM target_updated');
    expect(authorityStatement).toContain('JOIN target_updated ON target_updated.id = inserted.event_id');
    expect(authorityStatement).toContain("LEFT('evt_signoff_' || inserted.id::text, 128)");
    expect(authorityStatement).toContain('CROSS JOIN audit_written');
  });

  it('fails closed when the target event update returns zero rows', async () => {
    const statements: string[] = [];
    const sql = vi.fn((parts: TemplateStringsArray) => {
      const text = parts.join('?');
      statements.push(text);
      if (text.includes('SELECT id FROM operation_events')) return Promise.resolve([{ id: 'evt-1' }]);
      if (text.includes('WITH target_updated AS')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await expect(createSignOffRow(sql as never, 'ws-1', 'user-1', {
      event_id: 'evt-1', verdict: 'approved', decision_kind: 'approval',
    }, 'req-1')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      message: 'sign-off target was not updated; receipt not issued',
    });

    expect(statements).toHaveLength(2);
    const authorityStatement = statements[1];
    expect(authorityStatement).toContain('INSERT INTO sign_offs');
    expect(authorityStatement).toContain('FROM target_updated');
    expect(authorityStatement).toContain('JOIN target_updated ON target_updated.id = inserted.event_id');
  });
});
