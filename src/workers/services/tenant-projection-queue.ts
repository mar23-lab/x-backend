import type { GraphPersistDeps, PersistResult } from '../graph/persist-data-graph';
import { persistDataGraph } from '../graph/persist-data-graph';
import type { ProjectionOutboxRow } from '../dal/projection-outbox-store';

export const TENANT_PROJECTION_QUEUE_NAME = 'xlooop-tenant-projection';
export const TENANT_PROJECTION_DLQ_NAME = 'xlooop-tenant-projection-dlq';
export const TENANT_PROJECTION_MESSAGE_SCHEMA = 'xlooop.tenant_projection.v1';

export interface TenantProjectionMessage {
  schema_id: typeof TENANT_PROJECTION_MESSAGE_SCHEMA;
  outbox_id: string;
  workspace_id: string;
  event_type: string;
}

export interface ProjectionOutboxGateway {
  claim(limit: number, nowIso: string, staleBeforeIso: string): Promise<ProjectionOutboxRow[]>;
  markDispatched(ids: string[], nowIso: string): Promise<number>;
  releaseDispatch(ids: string[], errorCode: string): Promise<number>;
  beginAttempt(workspaceId: string, outboxId: string, nowIso: string): Promise<ProjectionOutboxRow | null>;
  markProcessed(workspaceId: string, outboxId: string, nowIso: string): Promise<number>;
  markFailed(workspaceId: string, outboxId: string, errorCode: string): Promise<number>;
  markDeadLettered(workspaceId: string, outboxId: string, nowIso: string, errorCode: string): Promise<number>;
}

export interface ProjectionQueueBinding {
  sendBatch(messages: Array<{ body: TenantProjectionMessage; contentType: 'json' }>): Promise<unknown>;
}

export interface ProjectionQueueMessage {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ProjectionQueueBatch {
  queue: string;
  messages: readonly ProjectionQueueMessage[];
}

export interface ProjectionDispatchResult {
  status: 'skipped' | 'completed' | 'failed';
  claimed: number;
  dispatched: number;
  error_code?: string;
}

const safeErrorCode = (value: unknown): string => {
  const name = value instanceof Error ? value.name : 'Error';
  return `projection_${name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()}`.slice(0, 80);
};

const validIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9:_-]+$/.test(value);

export function parseTenantProjectionMessage(value: unknown): TenantProjectionMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema_id !== TENANT_PROJECTION_MESSAGE_SCHEMA) return null;
  if (!validIdentifier(candidate.outbox_id) || !validIdentifier(candidate.workspace_id)) return null;
  if (candidate.event_type !== 'governed_intake.executed') return null;
  return {
    schema_id: TENANT_PROJECTION_MESSAGE_SCHEMA,
    outbox_id: candidate.outbox_id,
    workspace_id: candidate.workspace_id,
    event_type: candidate.event_type,
  };
}

export async function dispatchTenantProjectionOutbox(input: {
  enabled: boolean;
  gateway: ProjectionOutboxGateway;
  queue?: ProjectionQueueBinding;
  now: Date;
  limit?: number;
}): Promise<ProjectionDispatchResult> {
  if (!input.enabled) return { status: 'skipped', claimed: 0, dispatched: 0 };
  if (!input.queue) return { status: 'failed', claimed: 0, dispatched: 0, error_code: 'projection_queue_binding_missing' };
  const nowIso = input.now.toISOString();
  const staleBeforeIso = new Date(input.now.getTime() - 5 * 60_000).toISOString();
  const claimed = await input.gateway.claim(input.limit ?? 50, nowIso, staleBeforeIso);
  if (claimed.length === 0) return { status: 'completed', claimed: 0, dispatched: 0 };
  const ids = claimed.map((row) => row.id);
  try {
    await input.queue.sendBatch(claimed.map((row) => ({
      body: {
        schema_id: TENANT_PROJECTION_MESSAGE_SCHEMA,
        outbox_id: row.id,
        workspace_id: row.workspace_id,
        event_type: row.event_type,
      },
      contentType: 'json' as const,
    })));
    const dispatched = await input.gateway.markDispatched(ids, nowIso);
    return { status: 'completed', claimed: claimed.length, dispatched };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    await input.gateway.releaseDispatch(ids, errorCode);
    return { status: 'failed', claimed: claimed.length, dispatched: 0, error_code: errorCode };
  }
}

export interface ProjectionConsumeResult {
  acknowledged: number;
  retried: number;
  dead_lettered: number;
  invalid: number;
  projected: PersistResult[];
}

export async function consumeTenantProjectionBatch(input: {
  batch: ProjectionQueueBatch;
  gateway: ProjectionOutboxGateway;
  graph: GraphPersistDeps;
  now: () => Date;
  includeDocuments?: boolean;
}): Promise<ProjectionConsumeResult> {
  const result: ProjectionConsumeResult = { acknowledged: 0, retried: 0, dead_lettered: 0, invalid: 0, projected: [] };
  const isDeadLetterBatch = input.batch.queue === TENANT_PROJECTION_DLQ_NAME;
  for (const message of input.batch.messages) {
    const body = parseTenantProjectionMessage(message.body);
    if (!body) {
      message.ack();
      result.acknowledged += 1;
      result.invalid += 1;
      continue;
    }
    const nowIso = input.now().toISOString();
    if (isDeadLetterBatch) {
      await input.gateway.markDeadLettered(body.workspace_id, body.outbox_id, nowIso, 'projection_queue_retries_exhausted');
      message.ack();
      result.acknowledged += 1;
      result.dead_lettered += 1;
      continue;
    }
    const row = await input.gateway.beginAttempt(body.workspace_id, body.outbox_id, nowIso);
    if (!row) {
      message.ack();
      result.acknowledged += 1;
      continue;
    }
    if (row.event_type !== body.event_type) {
      await input.gateway.markDeadLettered(body.workspace_id, body.outbox_id, nowIso, 'projection_event_type_mismatch');
      message.ack();
      result.acknowledged += 1;
      result.dead_lettered += 1;
      continue;
    }
    try {
      const projected = await persistDataGraph(input.graph, body.workspace_id, nowIso, { includeDocuments: input.includeDocuments });
      await input.gateway.markProcessed(body.workspace_id, body.outbox_id, input.now().toISOString());
      message.ack();
      result.acknowledged += 1;
      result.projected.push(projected);
    } catch (error) {
      await input.gateway.markFailed(body.workspace_id, body.outbox_id, safeErrorCode(error));
      const delaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, Math.min(message.attempts - 1, 6))));
      message.retry({ delaySeconds });
      result.retried += 1;
    }
  }
  return result;
}
