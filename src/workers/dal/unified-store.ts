// unified-store.ts · the durable operations_unified read-model (Wave 5a).
//
// Authority: 022_operations_unified. The governance plane lives only as a JSONB envelope inside
// operations_live_stream_snapshots (parsed on every chat request). This materializes those rows into
// a queryable, plane-labelled, provenance-stamped table so chat/board/analytics read SQL. The stored
// rows are FAITHFUL to the source (raw state/stream_type/timestamp), so the read path reconstructs a
// GovernanceStreamRow and reuses the UNCHANGED cockpit-chat mapper — the table is a durable mirror,
// not a second classification. ADDITIVE: the route reads this first and falls back to the JSONB parse,
// so a missing/empty/failed table never breaks the working chat.

import type { Sql } from '../db/client';

/** A governance row as the route consumes it (a subset of cockpit-chat's GovernanceStreamRow). */
export interface UnifiedGovernanceRow {
  row_id: string;
  stream_type: string;
  state: string;
  workspace_id: string;
  project_id: string;
  domain_id: string;
  title: string;
  summary: string;
  timestamp_iso: string;
  source_adapter: string;
  evidence_refs: Array<{ uri: string | null; label: string }>;
}

const str = (v: unknown): string => (v == null ? '' : String(v));

/**
 * Materialize the governance rows of a live-stream envelope into operations_unified (plane
 * 'governance'). Idempotent — upsert by id 'gov:<row_id>', so re-ingesting a snapshot refreshes rows
 * in place. Returns how many rows were written. Best-effort at the call site (never fail the ingest).
 */
export async function materializeGovernanceSnapshotRow(
  sql: Sql,
  rows: Array<Record<string, unknown>> | null | undefined,
): Promise<number> {
  const list = Array.isArray(rows) ? rows : [];
  let n = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const rowId = str(r.row_id);
    if (!rowId) continue;
    const evRefs = Array.isArray(r.evidence_refs) ? (r.evidence_refs as Array<{ uri?: string | null }>) : [];
    const evidence = evRefs.find((e) => e && e.uri)?.uri ?? null;
    await sql/*sql*/`
      INSERT INTO operations_unified
        (id, plane, source_plane_id, workspace_id, project_id, domain_id, kind, status, title, summary, evidence_link, occurred_at)
      VALUES (
        ${'gov:' + rowId}, 'governance', ${rowId},
        ${str(r.workspace_id) || null}, ${str(r.project_id) || null}, ${str(r.domain_id || r.domain) || null},
        ${str(r.stream_type) || null}, ${str(r.state || r.status) || null},
        ${str(r.title) || null}, ${str(r.summary) || null}, ${evidence},
        ${str(r.timestamp_iso) ? str(r.timestamp_iso) : null}
      )
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id, project_id = EXCLUDED.project_id, domain_id = EXCLUDED.domain_id,
        kind = EXCLUDED.kind, status = EXCLUDED.status, title = EXCLUDED.title, summary = EXCLUDED.summary,
        evidence_link = EXCLUDED.evidence_link, occurred_at = EXCLUDED.occurred_at, ingested_at = now()
    `;
    n += 1;
  }
  return n;
}

/**
 * Read the materialized governance plane, reconstructed into GovernanceStreamRow shape so the caller
 * can scope + map it with the SAME cockpit-chat mapper used for the JSONB path. Newest first, bounded.
 * Empty when nothing is materialized yet (the caller then falls back to the JSONB envelope).
 */
export async function listUnifiedGovernanceRow(
  sql: Sql,
  limit = 500,
): Promise<UnifiedGovernanceRow[]> {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 500));
  const rows = (await sql/*sql*/`
    SELECT source_plane_id, kind, status, workspace_id, project_id, domain_id, title, summary, evidence_link, occurred_at
    FROM operations_unified
    WHERE plane = 'governance'
    ORDER BY occurred_at DESC NULLS LAST
    LIMIT ${cap}
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    row_id: str(r.source_plane_id),
    stream_type: str(r.kind),
    state: str(r.status),
    workspace_id: str(r.workspace_id),
    project_id: str(r.project_id),
    domain_id: str(r.domain_id),
    title: str(r.title),
    summary: str(r.summary),
    timestamp_iso: r.occurred_at ? new Date(r.occurred_at as string).toISOString() : '',
    source_adapter: '',
    evidence_refs: r.evidence_link ? [{ uri: str(r.evidence_link), label: 'evidence' }] : [],
  }));
}
