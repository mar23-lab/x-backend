// pmf-store.test.ts · 2026-06-08
// Unit tests for the PMF store: the very-disappointed % computation + input validation.

import { describe, it, expect } from 'vitest';
import { recordPmfResponseRow, getPmfSummaryRow } from '../dal/pmf-store';

function mockSql(row: Record<string, unknown>) {
  return ((..._a: unknown[]) => Promise.resolve([row])) as unknown as Parameters<typeof getPmfSummaryRow>[0];
}

describe('getPmfSummaryRow', () => {
  it('computes very_disappointed_pct (1 decimal)', async () => {
    const s = await getPmfSummaryRow(mockSql({ total: 8, very_disappointed: 5, somewhat_disappointed: 2, not_disappointed: 1 }));
    expect(s.total).toBe(8);
    expect(s.very_disappointed).toBe(5);
    expect(s.very_disappointed_pct).toBe(62.5); // 5/8
  });

  it('returns 0% when there are no responses', async () => {
    const s = await getPmfSummaryRow(mockSql({ total: 0, very_disappointed: 0, somewhat_disappointed: 0, not_disappointed: 0 }));
    expect(s.total).toBe(0);
    expect(s.very_disappointed_pct).toBe(0);
  });
});

describe('recordPmfResponseRow', () => {
  it('rejects an invalid sentiment', async () => {
    await expect(
      recordPmfResponseRow(mockSql({}), { user_id: 'u1', sentiment: 'bad' as never }),
    ).rejects.toThrow(/sentiment/i);
  });

  it('rejects a missing user_id', async () => {
    await expect(
      recordPmfResponseRow(mockSql({}), { user_id: '', sentiment: 'very_disappointed' }),
    ).rejects.toThrow(/user_id/i);
  });

  it('returns the recorded row on valid input', async () => {
    const row = {
      id: 'pmf_1', user_id: 'u1', workspace_id: 'ws1', sentiment: 'very_disappointed',
      benefit: null, improvement: null, persona: null, created_at: 'now', updated_at: 'now',
    };
    const r = await recordPmfResponseRow(mockSql(row), { user_id: 'u1', workspace_id: 'ws1', sentiment: 'very_disappointed' });
    expect(r.id).toBe('pmf_1');
    expect(r.sentiment).toBe('very_disappointed');
  });
});
