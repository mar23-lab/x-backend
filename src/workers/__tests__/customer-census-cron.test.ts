// customer-census-cron.test.ts · J-E TASK 2 (260719) · the OBSERVE-only census loop's safety + wiring.
// Pins: BORN-OFF (flag unset ⇒ ZERO reads/writes), gateway-unbound ⇒ skip, flag-on aggregation + persistence,
// per-workspace error isolation ⇒ 'degraded', and the never-remediates contract (no write beyond the
// observation row). The census MATH itself is proven in lib/__tests__/customer-census.test.ts.
// Q-A (260720) adds the store-level enumeration pins: typed DBs exclude mirror/bootstrap workspaces;
// pre-085 DBs (column absent) fall back to the unfiltered enumeration — never break the cron.

import { describe, it, expect, vi } from 'vitest';
import { customerCensusCron } from '../crons/customer-census';
import { listWorkspaceIdsForCensusRow } from '../dal/customer-census-store';
import type { DataGraphFacts } from '../graph/data-graph';

const WS = 'ws1';

function facts(): DataGraphFacts {
  return {
    workspaces: [{ id: WS, name: 'WS1' }],
    projects: [{ id: 'projA', workspace_id: WS }],
    lenses: [],
    memberships: [],
    intents: [{ id: 'int1', workspace_id: WS, project_id: null, title: 'dangling' }],
    unified: [
      { id: 'ev1', plane: 'event_sourcing', workspace_id: WS, project_id: 'projA' },
      { id: 'ev2', plane: 'event_sourcing', workspace_id: WS, project_id: null },
    ],
    bindings: [],
    packets: [],
  };
}

function makeCtx(env: Record<string, string>, opts: {
  bindGateway?: boolean;
  workspaceIds?: string[];
  assembleImpl?: (ws: string) => Promise<DataGraphFacts>;
  recordImpl?: () => Promise<void>;
} = {}) {
  const recordObservation = vi.fn(opts.recordImpl ?? (async () => {}));
  const listWorkspaceIds = vi.fn(async () => opts.workspaceIds ?? [WS]);
  const countIntakeResolutions = vi.fn(async () => 2);
  const assembleDataGraphFacts = vi.fn(opts.assembleImpl ?? (async () => facts()));
  const ctx = {
    dal: { assembleDataGraphFacts } as never,
    now: () => new Date('2026-07-19T05:00:00Z'),
    cronExpression: '0 5 * * *',
    env,
    ...(opts.bindGateway === false ? {} : { census: { listWorkspaceIds, countIntakeResolutions, recordObservation } }),
  };
  return { ctx: ctx as never, recordObservation, listWorkspaceIds, countIntakeResolutions, assembleDataGraphFacts };
}

describe('customerCensusCron · BORN-OFF safety', () => {
  it('flag unset (default) → skipped, ZERO reads/writes (byte-inert)', async () => {
    const { ctx, recordObservation, listWorkspaceIds, assembleDataGraphFacts } = makeCtx({});
    const r = await customerCensusCron(ctx);
    expect(r.status).toBe('skipped');
    expect(r.metadata?.reason).toBe('flag_disabled');
    expect(listWorkspaceIds).not.toHaveBeenCalled();
    expect(assembleDataGraphFacts).not.toHaveBeenCalled();
    expect(recordObservation).not.toHaveBeenCalled();
  });

  it('quoted "true" still enables (envFlagTrue — the quote-bug lesson applied to this flag)', async () => {
    const { ctx, listWorkspaceIds } = makeCtx({ CUSTOMER_CENSUS_ENABLED: '"true"' });
    const r = await customerCensusCron(ctx);
    expect(r.status).toBe('completed');
    expect(listWorkspaceIds).toHaveBeenCalled();
  });

  it('gateway unbound → skipped (dormant-safe), never throws', async () => {
    const { ctx, assembleDataGraphFacts } = makeCtx({ CUSTOMER_CENSUS_ENABLED: 'true' }, { bindGateway: false });
    const r = await customerCensusCron(ctx);
    expect(r.status).toBe('skipped');
    expect(r.metadata?.reason).toBe('census_gateway_unbound');
    expect(assembleDataGraphFacts).not.toHaveBeenCalled();
  });
});

describe('customerCensusCron · flag-on observation', () => {
  it('observes each workspace and persists a customer-safe row (counts only)', async () => {
    const { ctx, recordObservation } = makeCtx({ CUSTOMER_CENSUS_ENABLED: 'true' });
    const r = await customerCensusCron(ctx);
    expect(r.status).toBe('completed');
    expect(r.actions_taken).toBe(1);
    expect(recordObservation).toHaveBeenCalledTimes(1);
    const row = recordObservation.mock.calls[0][0];
    // population: 2 events, 1 intent, 0 docs
    expect(row.population_events).toBe(2);
    expect(row.population_intents).toBe(1);
    expect(row.orphan_unattributed_events).toBe(1);  // ev2 (null)
    expect(row.orphan_dangling_intents).toBe(1);      // int1 (no project)
    expect(row.governed_intake_resolutions).toBe(2);
    expect(row.orphan_set_hash).toMatch(/^orh_[0-9a-f]+$/);
    expect(row.graph_hash).toMatch(/^dgh_[0-9a-f]+$/);
    // customer-safe: the row carries NO work id/title/summary fields.
    expect(Object.keys(row).some((k) => /title|summary|content|prompt|body/i.test(k))).toBe(false);
  });

  it('aggregates across multiple workspaces', async () => {
    const { ctx, recordObservation } = makeCtx({ CUSTOMER_CENSUS_ENABLED: 'true' }, { workspaceIds: ['ws1', 'ws2'] });
    const r = await customerCensusCron(ctx);
    expect(r.status).toBe('completed');
    expect(r.actions_taken).toBe(2);
    expect(recordObservation).toHaveBeenCalledTimes(2);
    expect(r.metadata?.workspaces_observed).toBe(2);
  });

  it('a failing workspace is isolated → degraded, others still recorded', async () => {
    const { ctx, recordObservation } = makeCtx(
      { CUSTOMER_CENSUS_ENABLED: 'true' },
      {
        workspaceIds: ['ws1', 'ws2'],
        assembleImpl: async (ws: string) => { if (ws === 'ws2') throw new Error('db down'); return facts(); },
      },
    );
    const r = await customerCensusCron(ctx);
    expect(r.status).toBe('degraded');
    expect(r.metadata?.workspaces_observed).toBe(1);
    expect(r.metadata?.workspaces_errored).toBe(1);
    expect(recordObservation).toHaveBeenCalledTimes(1);
  });

  it('intake_resolutions read error degrades to 0, census still records', async () => {
    const { ctx, recordObservation } = makeCtx({ CUSTOMER_CENSUS_ENABLED: 'true' });
    // override countIntakeResolutions to throw
    (ctx as unknown as { census: { countIntakeResolutions: () => Promise<number> } }).census.countIntakeResolutions =
      vi.fn(async () => { throw new Error('no intake_resolutions table'); });
    const r = await customerCensusCron(ctx);
    expect(r.status).toBe('completed');
    expect(recordObservation).toHaveBeenCalledTimes(1);
    expect(recordObservation.mock.calls[0][0].governed_intake_resolutions).toBe(0);
  });
});

// ── Q-A (260720) · store-level enumeration: workspace typing filter + pre-085 fallback ──────────
//
// listWorkspaceIdsForCensusRow is the ONLY place the census picks its population. Mirrors/bootstrap
// rows are MB-P projections, not tenants — a typed DB (mig 085 applied) must exclude them. The
// migration is STAGED, so a pre-085 DB (workspace_type absent → 42703 on the typed query) MUST fall
// back to today's unfiltered enumeration, never fail the cron.

/** Tagged-template sql mock: typed query behaviour is injectable; records every query text. */
function mockCensusSql(opts: {
  typedRows?: Array<{ id: string }>;
  typedError?: Error;
  fallbackRows?: Array<{ id: string }>;
}) {
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const q = (strings as unknown as string[]).join('?');
    queries.push(q);
    if (/workspace_type/i.test(q)) {
      if (opts.typedError) return Promise.reject(opts.typedError);
      return Promise.resolve(opts.typedRows ?? []);
    }
    return Promise.resolve(opts.fallbackRows ?? []);
  }) as never;
  return { sql, queries };
}

describe('listWorkspaceIdsForCensusRow · Q-A workspace typing filter', () => {
  it('typed DB → mirror/bootstrap workspaces are EXCLUDED by the SQL filter', async () => {
    // The DB applies the WHERE clause; the store must issue it. Assert the query carries the
    // exclusion and the typed result is returned as-is (tenants only).
    const { sql, queries } = mockCensusSql({
      typedRows: [{ id: 'mbp-private' }, { id: 'org_customerA' }],
    });
    const ids = await listWorkspaceIdsForCensusRow(sql, 500);
    expect(ids).toEqual(['mbp-private', 'org_customerA']);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/workspace_type NOT IN \('mirror', 'bootstrap'\)/);
    // fail-open guard for rows predating the backfill (defensive; column is NOT NULL post-085)
    expect(queries[0]).toMatch(/workspace_type IS NULL/);
  });

  it('pre-085 DB (column absent) → falls back to the UNFILTERED enumeration (fail-open)', async () => {
    const err = Object.assign(new Error('column "workspace_type" does not exist'), { code: '42703' });
    const { sql, queries } = mockCensusSql({
      typedError: err,
      fallbackRows: [{ id: 'mbp-private' }, { id: 'x-docs' }, { id: 'xcp-platform' }],
    });
    const ids = await listWorkspaceIdsForCensusRow(sql, 500);
    // today's behaviour exactly: every workspace, mirrors included — the cron never breaks
    expect(ids).toEqual(['mbp-private', 'x-docs', 'xcp-platform']);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/workspace_type/);
    expect(queries[1]).not.toMatch(/workspace_type/);
  });

  it('genuine DB outage → BOTH queries fail and the error propagates (cron top-level catch owns it)', async () => {
    const boom = new Error('db down');
    const sql = ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.reject(boom)) as never;
    await expect(listWorkspaceIdsForCensusRow(sql, 500)).rejects.toThrow('db down');
  });
});
