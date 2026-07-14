// mcp-access-store.ts · L2 (260710-D) · day-grain MCP tenant-read audit (migration 063).
//
// The 059/D4 parent pattern (document-access-store.ts) re-instantiated at TOOL grain: one upsert per
// read, deduplicated per (workspace, tool, actor, day) → bounded growth + "which agent read what, when,
// how often" answers. Callers fire-and-forget via ctx.executionCtx.waitUntil — a read is NEVER slowed
// by its own audit. Degrade-safe: pre-063 schemas no-op silently (the audit accrues once 063 lands).
// instrument_kind uses the 050 actor-lineage vocabulary (this surface defaults 'agent').

import type { Sql } from '../db/client';

export async function recordMcpAccessRow(
  sql: Sql,
  workspaceId: string,
  tool: string,
  actorId: string,
  instrumentKind = 'agent',
): Promise<void> {
  const wsId = String(workspaceId || '').trim();
  const t = String(tool || '').trim();
  const actor = String(actorId || '').trim();
  if (!wsId || !t || !actor) return;
  try {
    await sql/*sql*/`
      INSERT INTO mcp_access_log (workspace_id, tool, actor_id, instrument_kind, access_date)
      VALUES (${wsId}, ${t}, ${actor}, ${instrumentKind}, CURRENT_DATE)
      ON CONFLICT (workspace_id, tool, actor_id, access_date)
      DO UPDATE SET read_count = mcp_access_log.read_count + 1, last_read_at = now()
    `;
  } catch { /* pre-063 schema or transient — the read must never fail on its audit */ }
}

/**
 * The fire-and-forget route hook (mirrors recordChatGroundingReads by construction):
 *   - flag off (enabled=false) → returns immediately, makeSql is NEVER called (no client built).
 *   - missing workspace/actor → returns, waitUntil NEVER called.
 *   - else → waitUntil(one upsert), attributed to the verified auth principal.
 * Never throws; `makeSql` is lazy so the Neon client is only built on the recording path.
 */
export function recordMcpRead(opts: {
  enabled: boolean;
  makeSql: () => Sql;
  workspaceId: string;
  tool: string;
  actorId: string;
  waitUntil: (p: Promise<unknown>) => void;
}): void {
  try {
    if (!opts.enabled) return;
    if (!String(opts.workspaceId || '').trim() || !String(opts.actorId || '').trim()) return;
    const sql = opts.makeSql();
    opts.waitUntil(recordMcpAccessRow(sql, opts.workspaceId, opts.tool, opts.actorId).then(() => {}));
  } catch { /* audit is best-effort — never surfaces to the read */ }
}
