// workspace-store-list.test.ts · Stage 1 · land-on-real-work
//
// Unit tests for listWorkspacesForOperatorRow's recency wiring. Mocks the sql
// tagged-template (captures the assembled query text + params, returns canned rows)
// so we assert WITHOUT a DB that the list:
//   1. SELECTs a last_event_at recency signal (max non-archived event occurred_at,
//      falling back to the workspace's updated_at), and
//   2. ORDERs by last_event_at DESC so the most-recently-active workspace sorts first,
//      while preserving the archived-filter, and
//   3. passes last_event_at through to the caller (→ route → hydrator → window.SPACES,
//      where resolve-current-workspace's activityScore() lands on it).

import { describe, it, expect } from 'vitest';
import { listWorkspacesForOperatorRow } from '../dal/workspace-store';

// A tagged-template stand-in that records the FULL assembled SQL text (template strings
// joined) + the interpolated params, and resolves a fixed set of rows. Ignores the query
// for execution — we only assert its SHAPE.
function captureSql(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push({ text: strings.join('?'), params });
    return Promise.resolve(rows);
  }) as unknown as Parameters<typeof listWorkspacesForOperatorRow>[0];
  return { sql, calls };
}

describe('listWorkspacesForOperatorRow · land-on-real-work recency', () => {
  it('short-circuits to [] (no query) when the owner-id set is empty', async () => {
    const { sql, calls } = captureSql([]);
    const out = await listWorkspacesForOperatorRow(sql, []);
    expect(out).toEqual([]);
    expect(calls.length).toBe(0); // tenant guard runs before any query
  });

  it('SELECTs a last_event_at recency signal from non-archived operation_events', async () => {
    const { sql, calls } = captureSql([]);
    await listWorkspacesForOperatorRow(sql, ['owner_1']);
    expect(calls.length).toBe(1);
    const text = calls[0].text;
    expect(text).toMatch(/last_event_at/);
    expect(text).toMatch(/max\(occurred_at\)/);
    expect(text).toMatch(/operation_events/);
    expect(text).toMatch(/archived_at IS NULL/);
    // recency-or-updated_at fallback: COALESCE wraps the subquery with the ws updated_at.
    expect(text).toMatch(/COALESCE/);
  });

  it('ORDERs by last_event_at DESC (most-recently-active first) and keeps the archived-filter', async () => {
    const { sql, calls } = captureSql([]);
    await listWorkspacesForOperatorRow(sql, ['owner_1']);
    const text = calls[0].text;
    expect(text).toMatch(/ORDER BY last_event_at DESC/);
    // the prior created_at ordering must be gone (it would re-introduce the no-op default)
    expect(text).not.toMatch(/ORDER BY created_at/);
    // archived workspaces stay filtered out
    expect(text).toMatch(/config->>'archived'/);
  });

  it('passes last_event_at through on each returned row', async () => {
    const { sql } = captureSql([
      { id: 'xlooop-xcp', name: 'Xlooop + XCP', owner_user_id: 'owner_1', slug: 'xlooop-xcp', config: {}, created_at: 'c', updated_at: 'u', last_event_at: '2026-06-09T10:00:00.000Z' },
      { id: 'empty-ws', name: 'Empty', owner_user_id: 'owner_1', slug: 'empty-ws', config: {}, created_at: 'c', updated_at: 'u', last_event_at: '2026-01-01T00:00:00.000Z' },
    ]);
    const out = await listWorkspacesForOperatorRow(sql, ['owner_1']);
    expect(out).toHaveLength(2);
    expect(out[0].last_event_at).toBe('2026-06-09T10:00:00.000Z');
    expect(out[1].last_event_at).toBe('2026-01-01T00:00:00.000Z');
  });
});
