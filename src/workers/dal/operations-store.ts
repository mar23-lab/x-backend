// operations-store.ts · operator-cockpit operations read/write models (R52-B1 layout overlay +
// R53-W2 operations-live-stream snapshots).
//
// Authority: DATABASE_SCHEMA_V1.md (operator_layout, operations_live_stream_snapshots) ·
// migrations 008+ · docs/architecture. Lifted verbatim out of WorkersDalAdapter (Stage 3.1, F10)
// to decompose the DAL god-object; behaviour is byte-for-byte identical to the prior inline methods.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). These methods are
// user-scoped (operator_layout: one row per operator) or operator/system-scoped (live-stream
// snapshots: MB-P push → DB → live read), NOT workspace-scoped, so there is no assertWorkspaceScope
// call — identical to the inline originals. They have no shared-helper coupling (each used a local
// `const sql = this.sql` + inline SQL + plain `new Error`), so they extract cleanly with no
// dependency on shared-helpers / DalAdapter / types.
//
// SMOKE/VERIFY NOTE: the inline SQL surfaces (operator_layout upsert ON CONFLICT (user_id);
// operations_live_stream_snapshots newest-row read + INSERT) MOVED here from WorkersDalAdapter.ts.
// The standalone source gates that grep the DAL for these were retargeted to read this store:
//   - scripts/verify-layout-persistence.mjs (R52-B1 "implements both with upsert")
//   - scripts/verify-live-stream-ingest.mjs (R53-W2 "implements both (newest-row read + insert)")

import type { UserId } from './types';
import type { Sql } from '../db/client';
import { materializeGovernanceSnapshotRow } from './unified-store';

// ------------------------------------------------------------
// R52-B1 · operator layout overlay (pillar 3)
// ------------------------------------------------------------

export async function getOperatorLayoutRow(
  sql: Sql,
  userId: UserId,
): Promise<{ user_id: string; layout: Record<string, unknown>; updated_at: string } | null> {
  if (!userId) throw new Error('getOperatorLayout: userId required');
  const rows = (await sql`
    SELECT user_id, layout, updated_at
    FROM operator_layout
    WHERE user_id = ${userId}
    LIMIT 1
  `) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    user_id: String(r.user_id),
    layout: (r.layout && typeof r.layout === 'object' ? r.layout : {}) as Record<string, unknown>,
    updated_at: r.updated_at ? new Date(r.updated_at as string).toISOString() : new Date().toISOString(),
  };
}

export async function putOperatorLayoutRow(
  sql: Sql,
  userId: UserId,
  layout: Record<string, unknown>,
): Promise<{ user_id: string; layout: Record<string, unknown>; updated_at: string }> {
  if (!userId) throw new Error('putOperatorLayout: userId required');
  const layoutJson = JSON.stringify(layout ?? { version: 1 });
  const rows = (await sql`
    INSERT INTO operator_layout (user_id, layout, updated_at, created_at)
    VALUES (${userId}, ${layoutJson}::jsonb, now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      layout = EXCLUDED.layout,
      updated_at = now()
    RETURNING user_id, layout, updated_at
  `) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) throw new Error(`putOperatorLayout: RETURNING produced no row for ${userId}`);
  return {
    user_id: String(r.user_id),
    layout: (r.layout && typeof r.layout === 'object' ? r.layout : {}) as Record<string, unknown>,
    updated_at: r.updated_at ? new Date(r.updated_at as string).toISOString() : new Date().toISOString(),
  };
}

// ------------------------------------------------------------
// R53-W2 · operations-live-stream snapshots (MB-P push → DB → live read)
// ------------------------------------------------------------

export async function getLatestLiveStreamSnapshotRow(
  sql: Sql,
  streamId: string = 'mbp-operations-live-stream',
): Promise<{ source_mode: string; generated_at: string; valid_until: string | null; rows_count: number; envelope: Record<string, unknown>; ingested_at: string } | null> {
  const rows = (await sql`
    SELECT source_mode, generated_at, valid_until, rows_count, envelope, ingested_at
    FROM operations_live_stream_snapshots
    WHERE stream_id = ${streamId}
    ORDER BY generated_at DESC
    LIMIT 1
  `) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    source_mode: String(r.source_mode || 'live_db'),
    generated_at: r.generated_at ? new Date(r.generated_at as string).toISOString() : new Date().toISOString(),
    valid_until: r.valid_until ? new Date(r.valid_until as string).toISOString() : null,
    rows_count: Number(r.rows_count || 0),
    envelope: (r.envelope && typeof r.envelope === 'object' ? r.envelope : {}) as Record<string, unknown>,
    ingested_at: r.ingested_at ? new Date(r.ingested_at as string).toISOString() : new Date().toISOString(),
  };
}

export async function putLiveStreamSnapshotRow(
  sql: Sql,
  input: {
    stream_id?: string;
    source_mode?: string;
    generated_at: string;
    valid_until?: string | null;
    rows_count?: number;
    sha256?: string | null;
    envelope: Record<string, unknown>;
  },
): Promise<{ id: string; stream_id: string; generated_at: string; rows_count: number }> {
  const streamId = input.stream_id || 'mbp-operations-live-stream';
  const sourceMode = input.source_mode || 'live_db';
  const rowsCount = Number.isFinite(input.rows_count as number) ? Number(input.rows_count) : 0;
  const envelopeJson = JSON.stringify(input.envelope ?? {});
  const rows = (await sql`
    INSERT INTO operations_live_stream_snapshots
      (stream_id, source_mode, generated_at, valid_until, rows_count, sha256, envelope, ingested_at)
    VALUES (
      ${streamId}, ${sourceMode}, ${input.generated_at},
      ${input.valid_until ?? null}, ${rowsCount}, ${input.sha256 ?? null},
      ${envelopeJson}::jsonb, now()
    )
    RETURNING id, stream_id, generated_at, rows_count
  `) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) throw new Error('putLiveStreamSnapshot: RETURNING produced no row');

  // Wave 5a · write-through to the durable operations_unified read-model. BEST-EFFORT: a missing
  // operations_unified table (migration 022 not yet applied) or any materialize error must NEVER fail
  // the snapshot ingest. The cockpit chat falls back to parsing this envelope until the table fills.
  try {
    const envRows = input.envelope && (input.envelope as { rows?: unknown }).rows;
    if (Array.isArray(envRows)) await materializeGovernanceSnapshotRow(sql, envRows as Array<Record<string, unknown>>);
  } catch (_) { /* best-effort mirror; the snapshot already persisted */ }

  return {
    id: String(r.id),
    stream_id: String(r.stream_id),
    generated_at: r.generated_at ? new Date(r.generated_at as string).toISOString() : input.generated_at,
    rows_count: Number(r.rows_count || 0),
  };
}
