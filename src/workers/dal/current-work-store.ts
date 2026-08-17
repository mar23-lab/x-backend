import { assertWorkspaceScope } from './DalAdapter';
import { withWorkspaceRlsContext } from './operational-spine-store';
import { visibilityForRole } from './visibility';
import type { Sql } from '../db/client';
import type { WorkspaceId, WorkspaceRole } from './types';

export type CurrentWorkState = 'needs_review' | 'blocked' | 'done' | 'active';

export interface CurrentWorkCompositeItem {
  id: string;
  object_type: 'event' | 'packet';
  project_id: string | null;
  intent_id: string | null;
  title: string;
  state: CurrentWorkState;
  updated_at: string;
}

export interface CurrentWorkCompositeProjection {
  counts: { needs_you: number; blocked: number; done: number; total: number };
  focus: CurrentWorkCompositeItem | null;
  source_watermark: string | null;
}

type ProjectionRow = {
  needs_you: number | string;
  blocked: number | string;
  done: number | string;
  total: number | string;
  source_watermark: string | null;
  id: string | null;
  object_type: 'event' | 'packet' | null;
  project_id: string | null;
  intent_id: string | null;
  title: string | null;
  state: CurrentWorkState | null;
  updated_at: string | null;
};

/**
 * One tenant-scoped Current Work projection over both canonical event records and
 * operational task packets. Packets already represented by a visible event are
 * removed so every unit of work is counted once, matching the customer activity
 * read model without deriving a workspace total from a page.
 */
export async function getCurrentWorkCompositeRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  opts: { role: WorkspaceRole; project_id?: string | null },
): Promise<CurrentWorkCompositeProjection> {
  assertWorkspaceScope(workspaceId);
  const visList = visibilityForRole(opts.role);
  const projectFilter = opts.project_id ?? null;
  const [rows] = await withWorkspaceRlsContext<[ProjectionRow[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      WITH visible_events AS (
        SELECT
          'event'::text AS object_type,
          e.id,
          e.project_id,
          e.intent_id,
          e.summary AS title,
          CASE
            WHEN e.status = 'needs_review' AND e.approval_state IS DISTINCT FROM 'approved' THEN 'needs_review'
            WHEN e.status = 'blocked' THEN 'blocked'
            WHEN e.status IN ('completed', 'approved') THEN 'done'
            ELSE 'active'
          END AS state,
          e.occurred_at AS updated_at
        FROM operation_events e
        WHERE e.workspace_id = ${workspaceId}
          AND e.archived_at IS NULL
          AND e.parent_event_id IS NULL
          AND e.visibility = ANY(${visList as unknown as string[]})
          AND (${projectFilter}::text IS NULL OR e.project_id = ${projectFilter}::text OR e.project_id IS NULL)
      ),
      packet_items AS (
        SELECT
          'packet'::text AS object_type,
          p.id,
          p.project_id,
          NULL::text AS intent_id,
          p.title,
          CASE
            WHEN p.lifecycle_state = 'approval_requested' THEN 'needs_review'
            WHEN p.lifecycle_state = 'rejected' THEN 'blocked'
            WHEN p.lifecycle_state IN ('approved', 'completed') THEN 'done'
            ELSE 'active'
          END AS state,
          p.updated_at
        FROM task_packets p
        WHERE p.workspace_id = ${workspaceId}
          AND p.lifecycle_state <> 'archived'
          AND (${projectFilter}::text IS NULL OR p.project_id = ${projectFilter}::text OR p.project_id IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM visible_events event_item WHERE event_item.id = p.event_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM governed_execution_receipts receipt
            JOIN visible_events event_item ON event_item.id = receipt.operation_event_id
            WHERE receipt.workspace_id = p.workspace_id
              AND receipt.target_type = 'task_packet'
              AND receipt.target_id = p.id
          )
      ),
      items AS (
        SELECT * FROM visible_events
        UNION ALL
        SELECT * FROM packet_items
      ),
      counts AS (
        SELECT
          count(*) FILTER (WHERE state = 'needs_review') AS needs_you,
          count(*) FILTER (WHERE state = 'blocked') AS blocked,
          count(*) FILTER (WHERE state = 'done') AS done,
          count(*) AS total,
          max(updated_at) AS source_watermark
        FROM items
      ),
      focus AS (
        SELECT *
        FROM items
        WHERE state IN ('needs_review', 'blocked')
        ORDER BY CASE state WHEN 'needs_review' THEN 0 ELSE 1 END, updated_at DESC, id DESC
        LIMIT 1
      )
      SELECT counts.needs_you, counts.blocked, counts.done, counts.total,
        counts.source_watermark,
        focus.id, focus.object_type, focus.project_id, focus.intent_id,
        focus.title, focus.state, focus.updated_at
      FROM counts
      LEFT JOIN focus ON true
    `,
  ], { readOnly: true });

  const row = rows[0] || ({} as ProjectionRow);
  const numberValue = (value: unknown) => Number(value ?? 0) || 0;
  const focus = row.id && row.object_type && row.state && row.title && row.updated_at
    ? {
        id: row.id,
        object_type: row.object_type,
        project_id: row.project_id ?? null,
        intent_id: row.intent_id ?? null,
        title: row.title,
        state: row.state,
        updated_at: row.updated_at,
      }
    : null;
  return {
    counts: {
      needs_you: numberValue(row.needs_you),
      blocked: numberValue(row.blocked),
      done: numberValue(row.done),
      total: numberValue(row.total),
    },
    focus,
    source_watermark: row.source_watermark ? String(row.source_watermark) : null,
  };
}
