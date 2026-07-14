// llm-usage-store.ts · G2 (260711) · day-grain per-tenant LLM usage metering (migration 064).
//
// The 059/063 parent pattern re-instantiated at USAGE grain: one upsert per LLM answer, accumulated per
// (workspace, model, user, day) → bounded growth + "which tenant/user drove how much model spend"
// answers — the commercial-staircase prerequisite (metering BEFORE any pricing/self-serve flag).
// Callers fire-and-forget via the GUARDED executionCtx accessor — an answer is NEVER slowed or failed
// by its metering. Degrade-safe: pre-064 schemas no-op silently (metering accrues once 064 lands).
//
// Deliberate skips (named, not accidental): a deterministic answer has model=null and never records
// (it is a free answer); the operator's UNSCOPED cockpit chat has workspace_id='' and never records
// (operator spend is not tenant spend — per-tenant metering only in v0). tokens 0 with calls_count>0
// means "provider didn't report usage" (Workers-AI usage is OPTIONAL), never "free".
// v1 backlog (named in GOVERNANCE_PILLARS): the operator/cron Llama surfaces (digest drafting, packet
// enrichment, prompt enhance, onboarding welcome) are unmetered — all operator-initiated free-tier.

import type { Sql } from '../db/client';

export interface LlmUsageRow {
  workspace_id: string;
  model: string;
  user_id: string;
  usage_date: string;
  calls_count: number;
  tokens_in: number;
  tokens_out: number;
  first_used_at: string | null;
  last_used_at: string | null;
}

export async function recordLlmUsageRow(
  sql: Sql,
  workspaceId: string,
  userId: string,
  model: string,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
): Promise<void> {
  const wsId = String(workspaceId || '').trim();
  const user = String(userId || '').trim();
  const m = String(model || '').trim();
  if (!wsId || !user || !m) return;
  const tin = Number.isFinite(Number(tokensIn)) ? Math.max(0, Math.floor(Number(tokensIn))) : 0;
  const tout = Number.isFinite(Number(tokensOut)) ? Math.max(0, Math.floor(Number(tokensOut))) : 0;
  try {
    await sql/*sql*/`
      INSERT INTO llm_usage_log (workspace_id, model, user_id, usage_date, tokens_in, tokens_out)
      VALUES (${wsId}, ${m}, ${user}, CURRENT_DATE, ${tin}, ${tout})
      ON CONFLICT (workspace_id, model, user_id, usage_date)
      DO UPDATE SET calls_count = llm_usage_log.calls_count + 1,
                    tokens_in = llm_usage_log.tokens_in + EXCLUDED.tokens_in,
                    tokens_out = llm_usage_log.tokens_out + EXCLUDED.tokens_out,
                    last_used_at = now()
    `;
  } catch { /* pre-064 schema or transient — the answer must never fail on its metering */ }
}

/**
 * The fire-and-forget route hook (mirrors recordMcpRead by construction):
 *   - flag off (enabled=false) → returns immediately, makeSql is NEVER called (no client built).
 *   - missing workspace/user/model → returns, waitUntil NEVER called (deterministic answers + the
 *     operator's unscoped chat are the deliberate skips documented in the header).
 *   - else → waitUntil(one accumulating upsert), attributed to the verified auth principal.
 * Never throws; `makeSql` is lazy so the Neon client is only built on the recording path.
 */
export function recordLlmUsage(opts: {
  enabled: boolean;
  makeSql: () => Sql;
  workspaceId: string;
  userId: string;
  model: string | null | undefined;
  tokensIn: number | null | undefined;
  tokensOut: number | null | undefined;
  waitUntil: (p: Promise<unknown>) => void;
}): void {
  try {
    if (!opts.enabled) return;
    if (!String(opts.workspaceId || '').trim() || !String(opts.userId || '').trim() || !String(opts.model || '').trim()) return;
    const sql = opts.makeSql();
    opts.waitUntil(recordLlmUsageRow(sql, opts.workspaceId, opts.userId, String(opts.model), opts.tokensIn, opts.tokensOut).then(() => {}));
  } catch { /* metering is best-effort — never surfaces to the answer */ }
}

/** Workspace-scoped read for the gated GET /api/v1/llm-usage route (newest days first). */
export async function listLlmUsageRow(sql: Sql, workspaceId: string, limit = 200): Promise<LlmUsageRow[]> {
  const wsId = String(workspaceId || '').trim();
  if (!wsId) return [];
  const cap = Math.min(Math.max(1, Math.floor(limit)), 500);
  try {
    const rows = (await sql/*sql*/`
      SELECT workspace_id, model, user_id, usage_date::text AS usage_date,
             calls_count, tokens_in, tokens_out,
             first_used_at::text AS first_used_at, last_used_at::text AS last_used_at
      FROM llm_usage_log
      WHERE workspace_id = ${wsId}
      ORDER BY usage_date DESC, model ASC, user_id ASC
      LIMIT ${cap}
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      workspace_id: String(r.workspace_id),
      model: String(r.model),
      user_id: String(r.user_id),
      usage_date: String(r.usage_date),
      calls_count: Number(r.calls_count) || 0,
      tokens_in: Number(r.tokens_in) || 0,
      tokens_out: Number(r.tokens_out) || 0,
      first_used_at: r.first_used_at == null ? null : String(r.first_used_at),
      last_used_at: r.last_used_at == null ? null : String(r.last_used_at),
    }));
  } catch { return []; /* pre-064 schema — the read degrades to empty */ }
}
