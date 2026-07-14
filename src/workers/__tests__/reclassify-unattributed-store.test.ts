// reclassify-unattributed-store.test.ts
//
// Store-level coverage for the reclassification primitives (dal/reclassify-store.ts)
// driven through the WorkersDalAdapter delegations, with a query-inspecting
// tagged-template `sql` mock (mirror access-request-dedup-update.test.ts style).
//
// Proves the SQL shape the cron depends on:
//   - split detection uses metadata->>'origin' = ALLACTIVITY_SPLIT_ORIGIN.
//   - the unattributed backlog is (project_id IS NULL OR project_id LIKE '%-allactivity'),
//     scoped to the workspace set, archived rows excluded, bounded by a LIMIT.
//   - the FK-safety set is just the project ids for the workspaces.
//   - the idempotent UPDATE is workspace-scoped AND re-asserts the unattributed
//     predicate (so a concurrent attribution makes it a no-op), and RETURNs rows.
//   - empty workspace set → NO query runs (never an unscoped scan).

import { describe, it, expect } from 'vitest';
import { WorkersDalAdapter } from '../dal/WorkersDalAdapter';
import { ALLACTIVITY_SPLIT_ORIGIN } from '../dal/reclassify-store';

type Row = Record<string, unknown>;

/** Query-inspecting tagged-template mock. `respond` decides each query's rows. */
function mockSql(respond: (q: string, values: unknown[]) => unknown[], captured: { queries: string[]; values: unknown[][] }) {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = (strings as unknown as string[]).join('?');
    captured.queries.push(q);
    captured.values.push(values);
    return Promise.resolve(respond(q, values));
  }) as never;
}

describe('reclassify-store · listSplitEnabledWorkspaceIds', () => {
  it('queries projects by metadata->>origin = the split marker and returns distinct workspace ids', async () => {
    const captured = { queries: [] as string[], values: [] as unknown[][] };
    const sql = mockSql((q) => {
      if (/FROM projects[\s\S]*metadata->>'origin'/i.test(q)) {
        return [{ workspace_id: 'ws_a' }, { workspace_id: 'ws_b' }];
      }
      return [];
    }, captured);
    const dal = new WorkersDalAdapter(sql);
    const ids = await dal.listSplitEnabledWorkspaceIds();

    expect(ids).toEqual(['ws_a', 'ws_b']);
    // the split marker is interpolated as a value (parameterised), not string-built.
    expect(captured.values[0]).toContain(ALLACTIVITY_SPLIT_ORIGIN);
    expect(captured.queries[0]).toMatch(/metadata->>'origin'/);
  });
});

describe('reclassify-store · listUnattributedEvents', () => {
  it('selects the NULL-or-allactivity backlog, scoped + archived-excluded + LIMITed', async () => {
    const captured = { queries: [] as string[], values: [] as unknown[][] };
    const sql = mockSql((q) => {
      if (/FROM operation_events/i.test(q)) {
        return [{ id: 'e1', workspace_id: 'ws_a', summary: 'feat: x' }];
      }
      return [];
    }, captured);
    const dal = new WorkersDalAdapter(sql);
    const rows = await dal.listUnattributedEvents(['ws_a', 'ws_b'], 500);

    expect(rows).toEqual([{ id: 'e1', workspace_id: 'ws_a', summary: 'feat: x' }]);
    const q = captured.queries[0];
    expect(q).toMatch(/project_id IS NULL OR project_id LIKE/i);
    expect(q).toMatch(/%-allactivity/);
    expect(q).toMatch(/archived_at IS NULL/i);
    expect(q).toMatch(/LIMIT/i);
    expect(q).toMatch(/workspace_id = ANY/i);
  });

  it('empty workspace set → returns [] WITHOUT running a query (never an unscoped scan)', async () => {
    const captured = { queries: [] as string[], values: [] as unknown[][] };
    const sql = mockSql(() => [{ id: 'should_not_appear' }], captured);
    const dal = new WorkersDalAdapter(sql);
    const rows = await dal.listUnattributedEvents([], 500);
    expect(rows).toEqual([]);
    expect(captured.queries).toHaveLength(0);
  });

  it('caps the LIMIT at 500 even if a larger bound is requested', async () => {
    const captured = { queries: [] as string[], values: [] as unknown[][] };
    const sql = mockSql(() => [], captured);
    const dal = new WorkersDalAdapter(sql);
    await dal.listUnattributedEvents(['ws_a'], 10_000);
    // the capped limit (500) is the last interpolated value of the query.
    expect(captured.values[0]).toContain(500);
  });
});

describe('reclassify-store · listProjectIdsForWorkspaces', () => {
  it('returns the set of existing project ids for the workspaces', async () => {
    const captured = { queries: [] as string[], values: [] as unknown[][] };
    const sql = mockSql((q) => {
      if (/SELECT id FROM projects WHERE workspace_id = ANY/i.test(q)) {
        return [{ id: 'ws_a-cockpit-ux' }, { id: 'ws_a-investor' }];
      }
      return [];
    }, captured);
    const dal = new WorkersDalAdapter(sql);
    const set = await dal.listProjectIdsForWorkspaces(['ws_a']);
    expect(set.has('ws_a-cockpit-ux')).toBe(true);
    expect(set.has('ws_a-investor')).toBe(true);
    expect(set.has('ws_a-funnel')).toBe(false);
  });

  it('empty workspace set → empty set, no query', async () => {
    const captured = { queries: [] as string[], values: [] as unknown[][] };
    const sql = mockSql(() => [{ id: 'nope' }], captured);
    const dal = new WorkersDalAdapter(sql);
    const set = await dal.listProjectIdsForWorkspaces([]);
    expect(set.size).toBe(0);
    expect(captured.queries).toHaveLength(0);
  });
});

describe('reclassify-store · reassignEventProject', () => {
  it('issues a workspace-scoped, unattributed-guarded UPDATE and returns rows updated', async () => {
    const captured = { queries: [] as string[], values: [] as unknown[][] };
    const sql = mockSql((q) => {
      if (/UPDATE operation_events[\s\S]*SET project_id/i.test(q)) {
        return [{ id: 'e1' }]; // one row updated
      }
      return [];
    }, captured);
    const dal = new WorkersDalAdapter(sql);
    const updated = await dal.reassignEventProject('ws_a', 'e1', 'ws_a-investor');

    expect(updated).toBe(1);
    const q = captured.queries[0];
    expect(q).toMatch(/UPDATE operation_events/i);
    expect(q).toMatch(/workspace_id = /i);
    // re-asserts the unattributed predicate so a concurrent attribution is a no-op.
    expect(q).toMatch(/project_id IS NULL OR project_id LIKE/i);
    expect(q).toMatch(/RETURNING id/i);
  });

  it('a guarded UPDATE that matches nothing → returns 0 (idempotent no-op)', async () => {
    const captured = { queries: [] as string[], values: [] as unknown[][] };
    const sql = mockSql(() => [], captured); // zero rows returned
    const dal = new WorkersDalAdapter(sql);
    const updated = await dal.reassignEventProject('ws_a', 'e_already_filed', 'ws_a-investor');
    expect(updated).toBe(0);
  });

  it('missing args → 0, no query', async () => {
    const captured = { queries: [] as string[], values: [] as unknown[][] };
    const sql = mockSql(() => [{ id: 'x' }], captured);
    const dal = new WorkersDalAdapter(sql);
    expect(await dal.reassignEventProject('', 'e1', 'p1')).toBe(0);
    expect(await dal.reassignEventProject('ws', '', 'p1')).toBe(0);
    expect(await dal.reassignEventProject('ws', 'e1', '')).toBe(0);
    expect(captured.queries).toHaveLength(0);
  });
});
