import { describe, expect, it, vi } from 'vitest';
import {
  TENANT_PROJECTION_DLQ_NAME,
  TENANT_PROJECTION_MESSAGE_SCHEMA,
  consumeTenantProjectionBatch,
  dispatchTenantProjectionOutbox,
  parseTenantProjectionMessage,
  type ProjectionOutboxGateway,
} from '../services/tenant-projection-queue';
import type { ProjectionOutboxRow } from '../dal/projection-outbox-store';
import type { DataGraphFacts } from '../graph/data-graph';

const NOW = new Date('2026-07-15T01:00:00Z');
const row = (over: Partial<ProjectionOutboxRow> = {}): ProjectionOutboxRow => ({
  id: 'out_1', workspace_id: 'ws_1', event_type: 'governed_intake.executed',
  aggregate_type: 'task_packet', aggregate_id: 'pkt_1', status: 'dispatched', attempt_count: 0,
  created_at: NOW.toISOString(), dispatched_at: NOW.toISOString(), processed_at: null, dead_lettered_at: null,
  ...over,
});

function gateway(over: Partial<ProjectionOutboxGateway> = {}) {
  return {
    claim: vi.fn(async () => []),
    markDispatched: vi.fn(async (ids: string[]) => ids.length),
    releaseDispatch: vi.fn(async (ids: string[]) => ids.length),
    beginAttempt: vi.fn(async () => row({ status: 'processing', attempt_count: 1 })),
    markProcessed: vi.fn(async () => 1),
    markFailed: vi.fn(async () => 1),
    markDeadLettered: vi.fn(async () => 1),
    ...over,
  } as ProjectionOutboxGateway & Record<string, ReturnType<typeof vi.fn>>;
}

const graph = (fail = false) => ({
  assembleDataGraphFacts: vi.fn(async (workspaceId: string): Promise<DataGraphFacts> => {
    if (fail) throw new Error('temporary database outage');
    return { workspaces: [{ id: workspaceId }], projects: [], lenses: [], memberships: [], intents: [], unified: [], packets: [] };
  }),
  getLatestGraphSnapshot: vi.fn(async () => null),
  replaceWorkspaceGraph: vi.fn(async () => undefined),
});

const body = { schema_id: TENANT_PROJECTION_MESSAGE_SCHEMA, outbox_id: 'out_1', workspace_id: 'ws_1', event_type: 'governed_intake.executed' } as const;
const message = (value: unknown = body, attempts = 1) => ({ body: value, attempts, ack: vi.fn(), retry: vi.fn() });

describe('tenant projection transactional outbox dispatcher', () => {
  it('is fully inert while disabled', async () => {
    const g = gateway();
    const result = await dispatchTenantProjectionOutbox({ enabled: false, gateway: g, now: NOW });
    expect(result).toEqual({ status: 'skipped', claimed: 0, dispatched: 0 });
    expect(g.claim).not.toHaveBeenCalled();
  });

  it('fails visibly when enabled without a Queue binding', async () => {
    const result = await dispatchTenantProjectionOutbox({ enabled: true, gateway: gateway(), now: NOW });
    expect(result).toMatchObject({ status: 'failed', error_code: 'projection_queue_binding_missing' });
  });

  it('publishes opaque tenant-bound messages and marks the claimed rows dispatched', async () => {
    const g = gateway({ claim: vi.fn(async () => [row()]) });
    const queue = { sendBatch: vi.fn(async () => undefined) };
    const result = await dispatchTenantProjectionOutbox({ enabled: true, gateway: g, queue, now: NOW });
    expect(result).toEqual({ status: 'completed', claimed: 1, dispatched: 1 });
    expect(queue.sendBatch).toHaveBeenCalledWith([{ body, contentType: 'json' }]);
    expect(JSON.stringify(queue.sendBatch.mock.calls[0])).not.toContain('payload');
  });

  it('releases claims for retry when Queue persistence fails', async () => {
    const g = gateway({ claim: vi.fn(async () => [row()]) });
    const result = await dispatchTenantProjectionOutbox({
      enabled: true, gateway: g, queue: { sendBatch: vi.fn(async () => { throw new TypeError('offline'); }) }, now: NOW,
    });
    expect(result).toMatchObject({ status: 'failed', claimed: 1, dispatched: 0, error_code: 'projection_typeerror' });
    expect(g.releaseDispatch).toHaveBeenCalledWith(['out_1'], 'projection_typeerror');
  });
});

describe('tenant projection Queue consumer', () => {
  it('rejects malformed or unsupported messages without touching tenant data', async () => {
    expect(parseTenantProjectionMessage({ ...body, workspace_id: '../other' })).toBeNull();
    const g = gateway(); const m = message({ raw: 'unsafe' });
    const result = await consumeTenantProjectionBatch({ batch: { queue: 'xlooop-tenant-projection', messages: [m] }, gateway: g, graph: graph(), now: () => NOW });
    expect(result).toMatchObject({ acknowledged: 1, invalid: 1, retried: 0 });
    expect(g.beginAttempt).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('binds outbox claim and graph projection to the same workspace then acknowledges', async () => {
    const g = gateway(); const gr = graph(); const m = message();
    const result = await consumeTenantProjectionBatch({ batch: { queue: 'xlooop-tenant-projection', messages: [m] }, gateway: g, graph: gr, now: () => NOW });
    expect(g.beginAttempt).toHaveBeenCalledWith('ws_1', 'out_1', NOW.toISOString());
    expect(gr.assembleDataGraphFacts).toHaveBeenCalledWith('ws_1', { includeDocuments: undefined });
    expect(g.markProcessed).toHaveBeenCalledWith('ws_1', 'out_1', NOW.toISOString());
    expect(result.projected).toHaveLength(1);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('records a safe failure code and retries with bounded exponential backoff', async () => {
    const g = gateway(); const m = message(body, 3);
    const result = await consumeTenantProjectionBatch({ batch: { queue: 'xlooop-tenant-projection', messages: [m] }, gateway: g, graph: graph(true), now: () => NOW });
    expect(g.markFailed).toHaveBeenCalledWith('ws_1', 'out_1', 'projection_error');
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(result.retried).toBe(1);
  });

  it('records exhausted messages from the DLQ without re-running projection', async () => {
    const g = gateway(); const gr = graph(); const m = message();
    const result = await consumeTenantProjectionBatch({ batch: { queue: TENANT_PROJECTION_DLQ_NAME, messages: [m] }, gateway: g, graph: gr, now: () => NOW });
    expect(g.markDeadLettered).toHaveBeenCalledWith('ws_1', 'out_1', NOW.toISOString(), 'projection_queue_retries_exhausted');
    expect(gr.assembleDataGraphFacts).not.toHaveBeenCalled();
    expect(result).toMatchObject({ acknowledged: 1, dead_lettered: 1, retried: 0 });
  });

  it('acks duplicate/already-processed deliveries when the tenant-bound claim returns no row', async () => {
    const g = gateway({ beginAttempt: vi.fn(async () => null) }); const m = message();
    const result = await consumeTenantProjectionBatch({ batch: { queue: 'xlooop-tenant-projection', messages: [m] }, gateway: g, graph: graph(), now: () => NOW });
    expect(result).toMatchObject({ acknowledged: 1, retried: 0 });
    expect(m.ack).toHaveBeenCalledOnce();
  });
});
