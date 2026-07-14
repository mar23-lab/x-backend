// feedback-store.ts · T6 (260710) · the Test-mode feedback persistence (migration 061).
//
// FeedbackAnnotations captures in-page annotations; this store makes them durable + operator-readable.
// Tenant-safe by construction: every read/write carries the workspace_id the ROUTE derived from the JWT.
// Degrade-safe reads (pre-061 schema → empty); the WRITE surfaces its error (a lost feedback submission
// must be visible to the submitter, unlike a best-effort audit mirror).

import type { Sql } from '../db/client';

export interface FeedbackRow {
  id: string;
  workspace_id: string;
  user_id: string;
  body: string;
  target_label: string | null;
  page: string | null;
  mode: string;
  status: string;
  created_at: string | null;
}

export interface FeedbackInput {
  workspace_id: string;
  user_id: string;
  body: string;
  target_label?: string | null;
  page?: string | null;
  mode?: string;
}

export async function insertFeedbackRow(sql: Sql, input: FeedbackInput): Promise<FeedbackRow> {
  const id = `fb_${crypto.randomUUID()}`;
  const rows = (await sql/*sql*/`
    INSERT INTO feedback (id, workspace_id, user_id, body, target_label, page, mode)
    VALUES (${id}, ${input.workspace_id}, ${input.user_id}, ${input.body},
            ${input.target_label ?? null}, ${input.page ?? null}, ${input.mode ?? 'test'})
    RETURNING id, workspace_id, user_id, body, target_label, page, mode, status, created_at
  `) as Array<Record<string, unknown>>;
  return toRow(rows[0]);
}

/** Today's submission count for (workspace, user) — the route's day-cap read. Degrades to 0. */
export async function countFeedbackTodayRow(sql: Sql, workspaceId: string, userId: string): Promise<number> {
  try {
    const rows = (await sql/*sql*/`
      SELECT count(*)::int AS n FROM feedback
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND created_at >= CURRENT_DATE
    `) as Array<{ n?: number }>;
    return Number(rows[0]?.n) || 0;
  } catch { return 0; }
}

export async function listFeedbackRow(sql: Sql, workspaceId: string, limit = 100): Promise<FeedbackRow[]> {
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  try {
    const rows = (await sql/*sql*/`
      SELECT id, workspace_id, user_id, body, target_label, page, mode, status, created_at
      FROM feedback WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC LIMIT ${cap}
    `) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  } catch { return []; }
}

function toRow(r: Record<string, unknown>): FeedbackRow {
  return {
    id: String(r.id ?? ''),
    workspace_id: String(r.workspace_id ?? ''),
    user_id: String(r.user_id ?? ''),
    body: String(r.body ?? ''),
    target_label: r.target_label == null ? null : String(r.target_label),
    page: r.page == null ? null : String(r.page),
    mode: String(r.mode ?? 'test'),
    status: String(r.status ?? 'open'),
    created_at: r.created_at == null ? null : String(r.created_at),
  };
}
