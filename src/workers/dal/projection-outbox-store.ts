import type { Sql } from '../db/client';

export type ProjectionOutboxStatus = 'pending' | 'dispatching' | 'dispatched' | 'processing' | 'processed' | 'dead_letter';

export interface ProjectionOutboxRow {
  id: string;
  workspace_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  status: ProjectionOutboxStatus;
  attempt_count: number;
  created_at: string;
  dispatched_at: string | null;
  processed_at: string | null;
  dead_lettered_at: string | null;
}

const normalize = (row: Record<string, unknown>): ProjectionOutboxRow => ({
  id: String(row.id),
  workspace_id: String(row.workspace_id),
  event_type: String(row.event_type),
  aggregate_type: String(row.aggregate_type),
  aggregate_id: String(row.aggregate_id),
  status: String(row.status) as ProjectionOutboxStatus,
  attempt_count: Number(row.attempt_count || 0),
  created_at: new Date(String(row.created_at)).toISOString(),
  dispatched_at: row.dispatched_at ? new Date(String(row.dispatched_at)).toISOString() : null,
  processed_at: row.processed_at ? new Date(String(row.processed_at)).toISOString() : null,
  dead_lettered_at: row.dead_lettered_at ? new Date(String(row.dead_lettered_at)).toISOString() : null,
});

/** Internal control-plane claim. This deliberately uses the owner connection because it scans a
 * bounded set across tenants; only opaque row/workspace identifiers leave this boundary. */
export async function claimProjectionOutboxRows(
  sql: Sql,
  limit: number,
  nowIso: string,
  staleBeforeIso: string,
): Promise<ProjectionOutboxRow[]> {
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await sql/*sql*/`
    WITH candidates AS (
      SELECT id
        FROM projection_outbox
       WHERE processed_at IS NULL
         AND dead_lettered_at IS NULL
         AND (
           status = 'pending'
           OR (status = 'dispatching' AND claimed_at < ${staleBeforeIso}::timestamptz)
         )
       ORDER BY created_at, id
       LIMIT ${bounded}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE projection_outbox o
       SET status = 'dispatching', claimed_at = ${nowIso}::timestamptz, last_error_code = NULL
      FROM candidates c
     WHERE o.id = c.id
    RETURNING o.id, o.workspace_id, o.event_type, o.aggregate_type, o.aggregate_id,
              o.status, o.attempt_count, o.created_at, o.dispatched_at, o.processed_at, o.dead_lettered_at
  ` as Array<Record<string, unknown>>;
  return rows.map(normalize);
}

export async function markProjectionOutboxDispatched(sql: Sql, ids: string[], nowIso: string): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await sql/*sql*/`
    UPDATE projection_outbox
       SET status = 'dispatched', dispatched_at = ${nowIso}::timestamptz, claimed_at = NULL
     WHERE id = ANY(${ids}::text[]) AND status = 'dispatching'
    RETURNING id
  ` as Array<{ id: string }>;
  return rows.length;
}

export async function releaseProjectionOutboxDispatch(sql: Sql, ids: string[], errorCode: string): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await sql/*sql*/`
    UPDATE projection_outbox
       SET status = 'pending', claimed_at = NULL, last_error_code = ${errorCode.slice(0, 80)}
     WHERE id = ANY(${ids}::text[]) AND status = 'dispatching'
    RETURNING id
  ` as Array<{ id: string }>;
  return rows.length;
}

/** Tenant-bound consumer claim. Both identifiers must match; payload data is never trusted. */
export async function beginProjectionOutboxAttempt(
  sql: Sql,
  workspaceId: string,
  outboxId: string,
  nowIso: string,
): Promise<ProjectionOutboxRow | null> {
  const rows = await sql/*sql*/`
    UPDATE projection_outbox
       SET status = 'processing', processing_started_at = ${nowIso}::timestamptz,
           attempt_count = attempt_count + 1, last_error_code = NULL
     WHERE id = ${outboxId}
       AND workspace_id = ${workspaceId}
       AND processed_at IS NULL
       AND dead_lettered_at IS NULL
       AND status IN ('dispatching','dispatched','processing')
    RETURNING id, workspace_id, event_type, aggregate_type, aggregate_id,
              status, attempt_count, created_at, dispatched_at, processed_at, dead_lettered_at
  ` as Array<Record<string, unknown>>;
  return rows[0] ? normalize(rows[0]) : null;
}

export async function markProjectionOutboxProcessed(
  sql: Sql,
  workspaceId: string,
  outboxId: string,
  nowIso: string,
): Promise<number> {
  const rows = await sql/*sql*/`
    UPDATE projection_outbox
       SET status = 'processed', processed_at = ${nowIso}::timestamptz,
           processing_started_at = NULL, last_error_code = NULL
     WHERE id = ${outboxId} AND workspace_id = ${workspaceId} AND processed_at IS NULL
    RETURNING id
  ` as Array<{ id: string }>;
  return rows.length;
}

export async function markProjectionOutboxFailed(
  sql: Sql,
  workspaceId: string,
  outboxId: string,
  errorCode: string,
): Promise<number> {
  const rows = await sql/*sql*/`
    UPDATE projection_outbox
       SET status = 'dispatched', processing_started_at = NULL, last_error_code = ${errorCode.slice(0, 80)}
     WHERE id = ${outboxId} AND workspace_id = ${workspaceId}
       AND processed_at IS NULL AND dead_lettered_at IS NULL
    RETURNING id
  ` as Array<{ id: string }>;
  return rows.length;
}

export async function markProjectionOutboxDeadLettered(
  sql: Sql,
  workspaceId: string,
  outboxId: string,
  nowIso: string,
  errorCode: string,
): Promise<number> {
  const rows = await sql/*sql*/`
    UPDATE projection_outbox
       SET status = 'dead_letter', dead_lettered_at = ${nowIso}::timestamptz,
           processing_started_at = NULL, last_error_code = ${errorCode.slice(0, 80)}
     WHERE id = ${outboxId} AND workspace_id = ${workspaceId} AND processed_at IS NULL
    RETURNING id
  ` as Array<{ id: string }>;
  return rows.length;
}
