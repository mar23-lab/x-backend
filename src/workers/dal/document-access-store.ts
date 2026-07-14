// document-access-store.ts · W4 (260708) · G3 — the day-grain document read-audit (migration 059).
//
// D4 decision: dedicated access telemetry, NOT evented reads (not causal facts; would flood the spine),
// NOT sampling (fails the auditor's question). One upsert per read, deduplicated per
// (workspace, document, user, day) → bounded growth + full "who/what/when-day/how-often" answers.
// Callers fire-and-forget via ctx.executionCtx.waitUntil — a read is NEVER slowed by its own audit.
// Degrade-safe: pre-059 schemas no-op silently (the audit accrues once the migration lands).

import type { Sql } from '../db/client';

export async function recordDocumentAccessRow(
  sql: Sql,
  workspaceId: string,
  documentId: string,
  userId: string,
  accessSource = 'chat_grounding',
): Promise<void> {
  const ws = String(workspaceId || '').trim();
  const doc = String(documentId || '').trim();
  const user = String(userId || '').trim();
  if (!ws || !doc || !user) return;
  try {
    await sql/*sql*/`
      INSERT INTO document_access_log (workspace_id, document_id, user_id, access_date, access_source)
      VALUES (${ws}, ${doc}, ${user}, CURRENT_DATE, ${accessSource})
      ON CONFLICT (workspace_id, document_id, user_id, access_date)
      DO UPDATE SET read_count = document_access_log.read_count + 1, last_read_at = now()
    `;
  } catch { /* pre-059 schema or transient — the read must never fail on its audit */ }
}

/**
 * C4 · the extracted, testable cockpit-chat grounding-read hook (was inlined in workspaces.ts POST
 * /cockpit-chat where the 995-LOC handler made it route-untestable). Fire-and-forget by construction:
 *   - flag off (enabled=false) → returns immediately, makeSql is NEVER called (no client built).
 *   - no groundable docs (empty / all id-less) → returns, waitUntil NEVER called.
 *   - else → waitUntil(allSettled(one upsert per doc)) attributed to the asking user, source 'chat_grounding'.
 * Never throws (the answer is never slowed/broken by its own audit). `makeSql` is lazy so the Neon client is
 * only built on the path that actually records; tests pass a capturing mock.
 */
export function recordChatGroundingReads(opts: {
  enabled: boolean;
  documents: ReadonlyArray<{ filename?: string; excerpt?: string; id?: unknown }>;
  makeSql: () => Sql;
  workspaceId: string;
  userId: string;
  waitUntil: (p: Promise<unknown>) => void;
}): void {
  try {
    if (!opts.enabled) return;
    const docIds = opts.documents.map((d) => (d && d.id ? String(d.id) : '')).filter(Boolean);
    if (!docIds.length) return;
    const sql = opts.makeSql();
    opts.waitUntil(
      Promise.allSettled(docIds.map((id) => recordDocumentAccessRow(sql, opts.workspaceId, id, opts.userId, 'chat_grounding'))).then(() => {}),
    );
  } catch { /* audit is best-effort — never surfaces to the chat answer */ }
}

export interface DocumentAccessRow {
  document_id: string;
  user_id: string;
  access_date: string;
  access_source: string;
  read_count: number;
  last_read_at: string | null;
}

export async function listDocumentAccessRow(sql: Sql, workspaceId: string, limit = 200): Promise<DocumentAccessRow[]> {
  const ws = String(workspaceId || '').trim();
  if (!ws) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 200));
  try {
    const rows = (await sql/*sql*/`
      SELECT document_id, user_id, access_date, access_source, read_count, last_read_at
      FROM document_access_log WHERE workspace_id = ${ws}
      ORDER BY access_date DESC, last_read_at DESC LIMIT ${cap}
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      document_id: String(r.document_id ?? ''),
      user_id: String(r.user_id ?? ''),
      access_date: r.access_date == null ? '' : String(r.access_date),
      access_source: String(r.access_source ?? ''),
      read_count: Number(r.read_count) || 0,
      last_read_at: r.last_read_at == null ? null : new Date(r.last_read_at as string).toISOString(),
    }));
  } catch { return []; }
}
