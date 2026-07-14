// usage-store.ts · privacy-safe usage telemetry (W1).
//
// Authority: 024_usage_events. Append-only IDS + COUNTS — never content. recordUsageEventRow logs one
// interaction (idempotent on id, so a client retry never double-counts); aggregateUsageForOperatorRow
// reads back {ref_id, clicks, last_used_at} for the operator's own rows, newest/most-used first. Both
// are wrapped best-effort at the call site — a telemetry failure must never break the live action.

import type { Sql } from '../db/client';

export interface UsageEventInput {
  id?: string;
  user_id: string;
  kind: string;
  ref_id?: string | null;
  scope_key?: string | null;
}

export interface UsageAggregateRow {
  ref_id: string;
  clicks: number;
  last_used_at: string;
}

const str = (v: unknown): string => (v == null ? '' : String(v));
const ALLOWED_KIND = new Set(['prompt_tag', 'chat_mode', 'screen', 'intent_action', 'connector_action']);

/** Record one usage interaction. id auto-generated when absent. Idempotent (ON CONFLICT DO NOTHING). */
export async function recordUsageEventRow(sql: Sql, input: UsageEventInput): Promise<void> {
  const userId = str(input.user_id).trim();
  const kind = str(input.kind).trim();
  if (!userId || !kind || !ALLOWED_KIND.has(kind)) return; // reject unknown kinds (keeps the sink clean)
  const id = str(input.id).trim() || `use-${crypto.randomUUID()}`;
  const refId = input.ref_id != null ? str(input.ref_id).slice(0, 120) : null;
  const scopeKey = input.scope_key != null ? str(input.scope_key).slice(0, 200) : null;
  await sql/*sql*/`
    INSERT INTO usage_events (id, user_id, kind, ref_id, scope_key)
    VALUES (${id}, ${userId}, ${kind}, ${refId}, ${scopeKey})
    ON CONFLICT (id) DO NOTHING
  `;
}

/** Aggregate the operator's own usage for a kind: {ref_id, clicks, last_used_at}, most-used first. */
export async function aggregateUsageForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  kind: string,
  limit = 100,
): Promise<UsageAggregateRow[]> {
  const ids = (Array.isArray(ownerUserIds) ? ownerUserIds : [ownerUserIds]).filter(Boolean);
  const k = str(kind).trim();
  if (ids.length === 0 || !k) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = (await sql/*sql*/`
    SELECT ref_id, COUNT(*)::int AS clicks, MAX(occurred_at) AS last_used_at
    FROM usage_events
    WHERE user_id = ANY(${ids}) AND kind = ${k} AND ref_id IS NOT NULL
    GROUP BY ref_id
    ORDER BY clicks DESC, last_used_at DESC
    LIMIT ${cap}
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ref_id: str(r.ref_id),
    clicks: Number(r.clicks) || 0,
    last_used_at: r.last_used_at ? new Date(r.last_used_at as string).toISOString() : '',
  }));
}
