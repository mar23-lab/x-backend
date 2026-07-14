// graph-rebuild-cron.test.ts · ADR-XLOOP-ARCH-004 Phase A · the graph POPULATION cron.
// Proves: iterates operator workspaces, calls persistDataGraph per ws (drift-aware), is best-effort
// (one bad ws never aborts), and skips cleanly with no operator identity. DAL faked.

import { describe, it, expect } from 'vitest';
import { graphRebuildCron } from '../crons/graph-rebuild';
import type { DataGraphFacts } from '../graph/data-graph';

const FACTS = (ws: string): DataGraphFacts => ({
  workspaces: [{ id: ws, name: ws }],
  projects: [{ id: `${ws}-p1`, workspace_id: ws, name: 'P1', created_at: '2026-06-01T00:00:00Z' }],
  lenses: [], memberships: [], intents: [],
  unified: [{ id: 'u1', plane: 'event_sourcing', source_plane_id: 'evt-1', workspace_id: ws, project_id: `${ws}-p1`, kind: 'github', occurred_at: '2026-06-03T00:00:00Z', summary: 'commit' }],
  bindings: [], causation: [],
});

function fakeDal(workspaceIds: string[], opts: { failWs?: string; ensure?: number; ensureThrows?: boolean } = {}) {
  const snapshots: Record<string, { graph_hash: string } | null> = {};
  const replaced: string[] = [];
  const ensureCalls: string[][] = [];
  return {
    listWorkspacesForOperator: async () => workspaceIds.map((id) => ({ id })),
    // ARCH-006 W2.1 (D2) — the cron ensures github source bindings before re-projecting.
    ensureGithubRepoBindingsForOperator: async (ids: string[]) => {
      ensureCalls.push(ids);
      if (opts.ensureThrows) throw new Error('binding backfill boom');
      return opts.ensure ?? 0;
    },
    assembleDataGraphFacts: async (ws: string) => { if (ws === opts.failWs) throw new Error('boom'); return FACTS(ws); },
    getLatestGraphSnapshot: async (ws: string) => (snapshots[ws] ?? null) as never,
    replaceWorkspaceGraph: async (ws: string, _n: unknown, _e: unknown, meta: { graph_hash: string }) => { snapshots[ws] = { graph_hash: meta.graph_hash }; replaced.push(ws); },
    _replaced: replaced,
    _ensureCalls: ensureCalls,
  } as Record<string, unknown>;
}

const ctx = (dal: Record<string, unknown>, env?: Record<string, string>) => ({
  dal: dal as never, now: () => new Date('2026-06-10T00:00:00Z'), cronExpression: '0 * * * *', env: env as never,
});

describe('graphRebuildCron', () => {
  it('rebuilds every operator workspace (drift=new → persisted)', async () => {
    const dal = fakeDal(['mbp-private', 'ws-2']);
    const r = await graphRebuildCron(ctx(dal, { MBP_OWNER_USER_ID: 'op' }));
    expect(r.status).toBe('completed');
    expect(r.actions_taken).toBe(2);            // both rebuilt
    expect((dal._replaced as string[]).sort()).toEqual(['mbp-private', 'ws-2']);
    expect((r.metadata as { nodes: number }).nodes).toBeGreaterThan(0);
  });

  it('skips cleanly with no operator identity', async () => {
    const r = await graphRebuildCron(ctx(fakeDal(['x']), {}));
    expect(r.status).toBe('skipped');
    expect(r.actions_taken).toBe(0);
  });

  it('best-effort: one failing workspace does not abort the others, and surfaces the failure (degraded)', async () => {
    const dal = fakeDal(['good-1', 'bad', 'good-2'], { failWs: 'bad' });
    const r = await graphRebuildCron(ctx(dal, { MBP_OWNER_USER_ID: 'op' }));
    expect((r.metadata as { errors: number; rebuilt: number }).errors).toBe(1);
    expect((r.metadata as { rebuilt: number }).rebuilt).toBe(2);  // the 2 good ones still rebuilt
    // ARCH-006 audit fix: a partial failure is no longer silently 'completed' — it is 'degraded',
    // and the failing workspace + its message are captured (the bug was: error count kept, message discarded).
    expect(r.status).toBe('degraded');
    expect((r.metadata as { degraded: boolean }).degraded).toBe(true);
    const details = (r.metadata as { error_details: Array<{ ws: string; msg: string }> }).error_details;
    expect(details).toHaveLength(1);
    expect(details[0].ws).toBe('bad');
    expect(details[0].msg.length).toBeGreaterThan(0);
    expect(r.notes).toContain('DEGRADED');
    expect(r.notes).toContain('failed_ws=bad');
  });

  // ARCH-006 W2.1 (D2) — the cron ensures github source bindings (operator-scoped) before re-projecting,
  // so the data-graph's source/feeds edges become real. The count is recorded in metadata.
  it('ensures github source bindings (operator ids) and records the count', async () => {
    const dal = fakeDal(['mbp-private'], { ensure: 51 });
    const r = await graphRebuildCron(ctx(dal, { MBP_OWNER_USER_ID: 'op', MBP_OWNER_LINKED_USER_IDS: 'op2' }));
    expect((dal._ensureCalls as string[][]).length).toBe(1);
    expect((dal._ensureCalls as string[][])[0]).toEqual(['op', 'op2']); // operator identity set
    expect((r.metadata as { bindings_ensured: number }).bindings_ensured).toBe(51);
    expect(r.status).toBe('completed');
  });

  it('a failing binding backfill NEVER aborts the rebuild (best-effort)', async () => {
    const dal = fakeDal(['mbp-private'], { ensureThrows: true });
    const r = await graphRebuildCron(ctx(dal, { MBP_OWNER_USER_ID: 'op' }));
    expect((r.metadata as { bindings_ensured: number }).bindings_ensured).toBe(0); // swallowed
    expect((r.metadata as { rebuilt: number }).rebuilt).toBe(1); // rebuild still ran
    expect(r.status).toBe('completed');
  });
});
