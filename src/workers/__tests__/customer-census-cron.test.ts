// customer-census-cron.test.ts · J-E TASK 2 (260719) · the OBSERVE-only census loop's safety + wiring.
// Pins: BORN-OFF (flag unset ⇒ ZERO reads/writes), gateway-unbound ⇒ skip, flag-on aggregation + persistence,
// per-workspace error isolation ⇒ 'degraded', and the never-remediates contract (no write beyond the
// observation row). The census MATH itself is proven in lib/__tests__/customer-census.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { customerCensusCron } from '../crons/customer-census';
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
