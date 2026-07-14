// access-request-dedup-update.test.ts
//
// Regression: createAccessRequest is idempotent-by-email. BEFORE this fix, a repeat
// submission for an email that already had a `pending` request RETURNED the stale row
// untouched, so a later funnel run's company_name was dropped (prod req_TzPnv... stayed
// company_name=null after a real re-submit on 2026-06-07). The fix REFRESHES the existing
// row (COALESCE new-non-null, else keep existing) and bumps updated_at. This suite asserts
// the dedup path now issues the UPDATE and persists the new company_name.

import { describe, it, expect } from 'vitest';
import { WorkersDalAdapter } from '../dal/WorkersDalAdapter';

type Row = Record<string, unknown>;

function baseRow(overrides: Row = {}): Row {
  return {
    id: 'req_existing', email: 'maratb2022@gmail.com', company_name: null, reason: null,
    source: 'web', status: 'pending', ip_address: null, user_agent: null, user_id: null,
    reviewed_at: null, reviewed_by: null, rejection_reason: null, invited_to_workspace_id: null,
    metadata: null, created_at: '2026-05-29T02:24:13Z', updated_at: '2026-05-29T02:24:13Z',
    ...overrides,
  };
}

// Query-inspecting tagged-template mock: returns `existing` for the dedup SELECT, and a
// refreshed row for the UPDATE that echoes the new company_name (the first interpolated value).
function mockSql(existing: Row, captured: { queries: string[] }) {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Array.isArray(strings) ? (strings as unknown as string[]).join('?') : String(strings);
    captured.queries.push(q);
    if (/SELECT[\s\S]*FROM access_requests[\s\S]*WHERE email/i.test(q)) {
      return Promise.resolve([existing]);
    }
    if (/UPDATE access_requests SET/i.test(q)) {
      const newCompany = values[0]; // COALESCE(${input.company_name ?? null}, company_name)
      return Promise.resolve([{ ...existing, company_name: newCompany ?? existing.company_name, updated_at: '2026-06-07T16:43:32Z' }]);
    }
    if (/INSERT INTO access_requests/i.test(q)) {
      return Promise.resolve([{ ...existing, id: 'req_new' }]);
    }
    return Promise.resolve([]);
  }) as never;
}

describe('createAccessRequest dedup-update — backfill company_name (regression)', () => {
  it('refreshes company_name on a repeat email (was silently dropped before the fix)', async () => {
    const captured = { queries: [] as string[] };
    const dal = new WorkersDalAdapter(mockSql(baseRow({ company_name: null }), captured));
    const result = await dal.createAccessRequest({ email: 'maratb2022@gmail.com', company_name: 'Honest & Young' } as never);

    // The fix MUST issue an UPDATE on the dedup path (the bug returned the row with no write)
    expect(captured.queries.some((qq) => /UPDATE access_requests SET/i.test(qq))).toBe(true);
    expect(result.company_name).toBe('Honest & Young'); // backfilled, was null
    expect(result.id).toBe('req_existing'); // same row (idempotent) — not a duplicate
  });

  it('keeps the existing company_name when the re-submit omits it (COALESCE new-non-null)', async () => {
    const captured = { queries: [] as string[] };
    const dal = new WorkersDalAdapter(mockSql(baseRow({ company_name: 'Acme Pty Ltd' }), captured));
    const result = await dal.createAccessRequest({ email: 'maratb2022@gmail.com' } as never);
    expect(result.company_name).toBe('Acme Pty Ltd'); // COALESCE(null, 'Acme Pty Ltd')
  });

  it('still INSERTs a fresh row when no pending request exists for the email', async () => {
    const captured = { queries: [] as string[] };
    // empty SELECT result → no existing → INSERT path
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = (strings as unknown as string[]).join('?');
      captured.queries.push(q);
      if (/SELECT[\s\S]*FROM access_requests[\s\S]*WHERE email/i.test(q)) return Promise.resolve([]);
      if (/INSERT INTO access_requests/i.test(q)) return Promise.resolve([baseRow({ id: 'req_new', company_name: 'New Co' })]);
      return Promise.resolve([]);
    }) as never;
    const dal = new WorkersDalAdapter(sql);
    const result = await dal.createAccessRequest({ email: 'fresh@x.com', company_name: 'New Co' } as never);
    expect(captured.queries.some((qq) => /INSERT INTO access_requests/i.test(qq))).toBe(true);
    expect(captured.queries.some((qq) => /UPDATE access_requests SET/i.test(qq))).toBe(false);
    expect(result.company_name).toBe('New Co');
  });
});
