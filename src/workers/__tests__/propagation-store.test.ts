// propagation-store.test.ts — CHARACTERIZATION tests (behaviour-lock, golden).
//
// Why this file exists: src/workers/dal/propagation-store.ts is a ~1056-LOC live DAL with 57 raw-SQL
// references and, until 2026-07-04, ZERO test coverage. It is on the FSD size-gate frozen-ceiling list
// (do-not-grow) and is explicitly OUT of scope for frontend decomposition. These tests do NOT change
// behaviour or the file — they LOCK the current observable behaviour so any future backend refactor /
// resize is provably safe. Priority is the tenant-isolation invariants (the reason this file is
// sensitive): the R55-3c write guard + the audit-260531 fail-closed read.
//
// Pattern: the repo's worker tests mock the DB rather than spinning up Postgres (see action-recording /
// recommendations-write-scope). We mock the postgres `Sql` tagged-template executor, recording every
// query and returning canned rows, which locks (a) query SHAPE, (b) result mapping, (c) guard ordering.

import { describe, it, expect } from 'vitest';
import {
  getRecommendationRow,
  listRecommendationsRow,
  acceptRecommendationRow,
  rejectRecommendationRow,
  getGoalRow,
} from '../dal/propagation-store';

type Row = Record<string, any>;

/** Build a mock `Sql` tagged-template. `responder(query, values)` returns the rows for each call.
 *  `query` is the normalized SQL text (whitespace-collapsed); `.calls` records every invocation. */
function makeSql(responder: (query: string, values: any[]) => Row[]) {
  const calls: Array<{ query: string; values: any[] }> = [];
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ query, values });
    return Promise.resolve(responder(query, values));
  };
  sql.calls = calls;
  return sql;
}

const rec = (over: Partial<Row> = {}): Row => ({
  id: 'rec_1', domain_id: 'dom_1', workspace_id: 'ws_mine', rule_id: null,
  source_event_ids: [], source_project_ids: [], kind: 'flag_blocker', payload: {},
  rationale: 'r', confidence: 0.5, status: 'pending',
  generated_at: '2026-01-01T00:00:00Z', expires_at: null, acted_by: null, acted_at: null,
  resolution_note: null, ...over,
});

const isSelectRec = (q: string) => /FROM synthetic_domain_recommendations WHERE id =/.test(q);
const isUpdateRec = (q: string) => /UPDATE synthetic_domain_recommendations/.test(q);

describe('propagation-store · getRecommendationRow — result mapping', () => {
  it('returns null when no row matches', async () => {
    const sql = makeSql(() => []);
    expect(await getRecommendationRow(sql, 'rec_x' as any)).toBeNull();
    expect(sql.calls.length).toBe(1);
    expect(isSelectRec(sql.calls[0].query)).toBe(true);
  });

  it('normalizes and returns the row when present', async () => {
    const sql = makeSql(() => [rec({ id: 'rec_9', workspace_id: 'ws_a' })]);
    const out = await getRecommendationRow(sql, 'rec_9' as any);
    expect(out).not.toBeNull();
    expect(out!.id).toBe('rec_9');
    expect(out!.workspace_id).toBe('ws_a');
  });
});

describe('propagation-store · listRecommendationsRow — audit-260531 FAIL-CLOSED tenant read', () => {
  it('SECURITY: no domain_id and no workspace scope → returns [] and issues NO query (never an unscoped all-tenant read)', async () => {
    const sql = makeSql(() => { throw new Error('must not query'); });
    const out = await listRecommendationsRow(sql, { status: 'pending' } as any);
    expect(out).toEqual([]);
    expect(sql.calls.length).toBe(0); // the whole point: fail closed BEFORE touching the DB
  });

  it('domain_id path issues a domain-scoped query', async () => {
    const sql = makeSql(() => [rec()]);
    await listRecommendationsRow(sql, { domain_id: 'dom_1', status: 'pending' } as any);
    expect(sql.calls.length).toBe(1);
    expect(/WHERE domain_id = \? AND status =/.test(sql.calls[0].query)).toBe(true);
  });

  it('workspaceIds path scopes by workspace_id = ANY(...)', async () => {
    const sql = makeSql(() => [rec()]);
    await listRecommendationsRow(sql, { workspaceIds: ['ws1'], status: 'pending' } as any);
    expect(/workspace_id = ANY\(\s*\?\s*\)/.test(sql.calls[0].query)).toBe(true);
    expect(/IS NULL/.test(sql.calls[0].query)).toBe(false);
  });

  it('workspaceIds + includeCrossWorkspace unions ANY(...) OR workspace_id IS NULL', async () => {
    const sql = makeSql(() => [rec()]);
    await listRecommendationsRow(sql, { workspaceIds: ['ws1'], includeCrossWorkspace: true, status: 'pending' } as any);
    expect(/workspace_id = ANY\(\s*\?\s*\) OR workspace_id IS NULL/.test(sql.calls[0].query)).toBe(true);
  });

  it('includeCrossWorkspace only (no workspaceIds) returns the cross-workspace NULL rows only', async () => {
    const sql = makeSql(() => [rec({ workspace_id: null })]);
    await listRecommendationsRow(sql, { includeCrossWorkspace: true, status: 'pending' } as any);
    expect(/AND workspace_id IS NULL/.test(sql.calls[0].query)).toBe(true);
    expect(/ANY\(/.test(sql.calls[0].query)).toBe(false);
  });
});

describe('propagation-store · acceptRecommendationRow — R55-3c tenant WRITE guard', () => {
  it('missing actor → VALIDATION_ERROR 400 before any query', async () => {
    const sql = makeSql(() => []);
    await expect(acceptRecommendationRow(sql, 'rec_1' as any, '' as any)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(sql.calls.length).toBe(0);
  });

  it('recommendation not found → NOT_FOUND 404', async () => {
    const sql = makeSql(() => []);
    await expect(acceptRecommendationRow(sql, 'rec_x' as any, 'user_1' as any)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('SECURITY: workspace-owned row NOT in caller scope → FORBIDDEN 403 and NO mutation issued', async () => {
    const sql = makeSql((q) => (isSelectRec(q) ? [rec({ workspace_id: 'ws_other', status: 'pending' })] : []));
    await expect(
      acceptRecommendationRow(sql, 'rec_1' as any, 'user_1' as any, undefined, { workspaceIds: ['ws_mine'], includeCrossWorkspace: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(sql.calls.some((c) => isUpdateRec(c.query))).toBe(false); // guard fires BEFORE the status flip
  });

  it('SECURITY: cross-workspace (NULL) row denied when includeCrossWorkspace=false → FORBIDDEN 403', async () => {
    const sql = makeSql((q) => (isSelectRec(q) ? [rec({ workspace_id: null, status: 'pending' })] : []));
    await expect(
      acceptRecommendationRow(sql, 'rec_1' as any, 'user_1' as any, undefined, { workspaceIds: ['ws_mine'], includeCrossWorkspace: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('guard PASSES when in scope: cross-workspace row + includeCrossWorkspace=true reaches the status check (non-pending → CONFLICT 409, not FORBIDDEN)', async () => {
    const sql = makeSql((q) => (isSelectRec(q) ? [rec({ workspace_id: null, status: 'accepted' })] : []));
    await expect(
      acceptRecommendationRow(sql, 'rec_1' as any, 'user_1' as any, undefined, { workspaceIds: ['ws_mine'], includeCrossWorkspace: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });

  it('no scope provided (backward-compat) → guard skipped; proceeds to status check (non-pending → CONFLICT 409)', async () => {
    const sql = makeSql((q) => (isSelectRec(q) ? [rec({ workspace_id: 'ws_other', status: 'rejected' })] : []));
    await expect(acceptRecommendationRow(sql, 'rec_1' as any, 'user_1' as any)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });
});

describe('propagation-store · rejectRecommendationRow — validation + guard mirror', () => {
  it('empty resolution_note → VALIDATION_ERROR 400', async () => {
    const sql = makeSql(() => []);
    await expect(rejectRecommendationRow(sql, 'rec_1' as any, 'user_1' as any, '   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(sql.calls.length).toBe(0);
  });

  it('SECURITY: out-of-scope row → FORBIDDEN 403 and NO mutation', async () => {
    const sql = makeSql((q) => (isSelectRec(q) ? [rec({ workspace_id: 'ws_other', status: 'pending' })] : []));
    await expect(
      rejectRecommendationRow(sql, 'rec_1' as any, 'user_1' as any, 'not relevant to us', { workspaceIds: ['ws_mine'], includeCrossWorkspace: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(sql.calls.some((c) => isUpdateRec(c.query))).toBe(false);
  });

  it('in-scope but already resolved → CONFLICT 409 (guard passed)', async () => {
    const sql = makeSql((q) => (isSelectRec(q) ? [rec({ workspace_id: 'ws_mine', status: 'accepted' })] : []));
    await expect(
      rejectRecommendationRow(sql, 'rec_1' as any, 'user_1' as any, 'stale', { workspaceIds: ['ws_mine'], includeCrossWorkspace: false }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });
});

describe('propagation-store · getGoalRow — result mapping', () => {
  it('returns null when absent', async () => {
    const sql = makeSql(() => []);
    expect(await getGoalRow(sql, 'goal_x' as any)).toBeNull();
  });

  it('normalizes numeric target/current values and defaults derivation', async () => {
    const sql = makeSql(() => [{
      id: 'goal_1', domain_id: 'dom_1', roadmap_id: null, workspace_id: 'ws_mine',
      title: 'G', description: null, metric_name: 'count', metric_unit: null,
      target_value: '10', current_value: '4', current_value_updated_at: null, target_date: null,
      status: 'active', derivation: null, metadata: null, created_by: 'u', updated_by: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    }]);
    const g = await getGoalRow(sql, 'goal_1' as any);
    expect(g!.target_value).toBe(10);       // string → number
    expect(g!.current_value).toBe(4);        // string → number
    expect(g!.derivation).toEqual({ kind: 'member_project_count' }); // null → default
  });
});
