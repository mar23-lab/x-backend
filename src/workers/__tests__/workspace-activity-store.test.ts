// workspace-activity-store.test.ts · 2026-06-07
//
// Unit tests for the workspace activity/value summary (retention-loop data layer).
// Mocks the sql tagged-template so we assert count mapping, days-of-history computation,
// empty-workspace handling, and the tenant guard — without a DB.

import { describe, it, expect } from 'vitest';
import { getWorkspaceActivitySummaryRow } from '../dal/workspace-activity-store';

// A tagged-template stand-in: ignores the query, resolves a single canned row.
function mockSql(row: Record<string, unknown>) {
  return ((..._args: unknown[]) => Promise.resolve([row])) as unknown as Parameters<
    typeof getWorkspaceActivitySummaryRow
  >[0];
}

describe('getWorkspaceActivitySummaryRow', () => {
  it('maps counts + computes days_of_history + echoes since', async () => {
    const sql = mockSql({
      events_total: 42, needs_you: 3, events_completed: 30, signoffs_total: 12, projects_total: 4,
      connected_sources: 2, first_activity_at: '2026-05-01T00:00:00Z', last_activity_at: '2026-06-06T00:00:00Z',
      events_since: 5, signoffs_since: 1,
    });
    const s = await getWorkspaceActivitySummaryRow(sql, 'ws1', '2026-06-05T00:00:00Z');
    expect(s.workspace_id).toBe('ws1');
    expect(s.events_total).toBe(42);
    expect(s.needs_you).toBe(3);
    expect(s.signoffs_total).toBe(12);
    expect(s.connected_sources).toBe(2);
    expect(s.events_since).toBe(5);
    expect(s.signoffs_since).toBe(1);
    expect(s.since).toBe('2026-06-05T00:00:00Z');
    expect(s.days_of_history).toBeGreaterThan(0);
  });

  it('handles an empty workspace (zeros, null history, 0 days, null since)', async () => {
    const sql = mockSql({
      events_total: 0, needs_you: 0, events_completed: 0, signoffs_total: 0, projects_total: 0,
      connected_sources: 0, first_activity_at: null, last_activity_at: null, events_since: 0, signoffs_since: 0,
    });
    const s = await getWorkspaceActivitySummaryRow(sql, 'ws2', null);
    expect(s.events_total).toBe(0);
    expect(s.first_activity_at).toBeNull();
    expect(s.days_of_history).toBe(0);
    expect(s.since).toBeNull();
  });

  it('rejects an empty workspace id (tenant guard, before any query)', async () => {
    await expect(getWorkspaceActivitySummaryRow(mockSql({}), '', null)).rejects.toThrow();
  });
});
