// workspace-activity-store.ts · accumulated-value + activity summary for a workspace.
//
// NORTH-STAR (operator, 2026-06-07): must-have-ness for regulated SMBs = indispensability via
// ACCUMULATION (audit-grade record + done-work), not engagement loops. This read powers:
//   1. the "value you'd lose" surface  — events/decisions/evidence/history that make leaving costly
//   2. the "since you left" return trigger — the delta since the operator's last visit
//   3. leading must-have indicators — measured against the lagging Sean-Ellis "very disappointed" %
//
// Read-only; reads existing tables (operation_events, sign_offs, projects, project_source_bindings).
// No migration. Workspace-scoped (tenant isolation enforced via assertWorkspaceScope).

import { assertWorkspaceScope } from './DalAdapter';
import type { Sql } from '../db/client';

export interface WorkspaceActivitySummary {
  workspace_id: string;
  /** Accumulated value (the switching cost). */
  events_total: number;
  events_completed: number;
  signoffs_total: number;
  projects_total: number;
  connected_sources: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
  days_of_history: number;
  /** Daily-action surface: events awaiting the operator (needs_review or approval pending). */
  needs_you: number;
  /** "Since you left" return-trigger delta (since the provided timestamp; null since = all-time). */
  since: string | null;
  events_since: number;
  signoffs_since: number;
}

export async function getWorkspaceActivitySummaryRow(
  sql: Sql,
  workspaceId: string,
  sinceIso?: string | null,
): Promise<WorkspaceActivitySummary> {
  assertWorkspaceScope(workspaceId);
  const since = sinceIso || '1970-01-01T00:00:00.000Z';
  const rows = (await sql/*sql*/`
    SELECT
      (SELECT count(*) FROM operation_events WHERE workspace_id = ${workspaceId} AND archived_at IS NULL)::int AS events_total,
      (SELECT count(*) FROM operation_events WHERE workspace_id = ${workspaceId}
         AND archived_at IS NULL AND (status = 'needs_review' OR approval_state = 'pending'))::int AS needs_you,
      (SELECT count(*) FROM operation_events WHERE workspace_id = ${workspaceId} AND status = 'completed')::int AS events_completed,
      (SELECT count(*) FROM sign_offs WHERE workspace_id = ${workspaceId})::int AS signoffs_total,
      (SELECT count(*) FROM projects WHERE workspace_id = ${workspaceId})::int AS projects_total,
      (SELECT count(*) FROM project_source_bindings WHERE workspace_id = ${workspaceId} AND status = 'connected')::int AS connected_sources,
      (SELECT min(occurred_at) FROM operation_events WHERE workspace_id = ${workspaceId}) AS first_activity_at,
      (SELECT max(occurred_at) FROM operation_events WHERE workspace_id = ${workspaceId}) AS last_activity_at,
      (SELECT count(*) FROM operation_events WHERE workspace_id = ${workspaceId} AND ingested_at > ${since})::int AS events_since,
      (SELECT count(*) FROM sign_offs WHERE workspace_id = ${workspaceId} AND signed_at > ${since})::int AS signoffs_since
  `) as Array<Record<string, unknown>>;

  const r = rows[0] || {};
  const num = (v: unknown) => Number(v || 0);
  const first = r.first_activity_at ? String(r.first_activity_at) : null;
  const days = first ? Math.max(0, Math.floor((Date.now() - new Date(first).getTime()) / 86400000)) : 0;

  return {
    workspace_id: workspaceId,
    events_total: num(r.events_total),
    events_completed: num(r.events_completed),
    signoffs_total: num(r.signoffs_total),
    projects_total: num(r.projects_total),
    connected_sources: num(r.connected_sources),
    first_activity_at: first,
    last_activity_at: r.last_activity_at ? String(r.last_activity_at) : null,
    days_of_history: days,
    needs_you: num(r.needs_you),
    since: sinceIso || null,
    events_since: num(r.events_since),
    signoffs_since: num(r.signoffs_since),
  };
}
