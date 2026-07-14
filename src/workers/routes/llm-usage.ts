// llm-usage.ts · G2 (260711) — the workspace-scoped LLM usage read (per-tenant metering surface).
//
// Serves the day-grain (workspace, model, user, day) call+token accumulators from llm_usage_log
// (migration 064). OWNER/OPERATOR-role gated (spend is a governance surface, not a viewer read) via
// the same gateCustomerWorkspace driver as the customer audit log. Tenant-safe by construction: the
// workspace is only ever the verified JWT's. Rows are ids + counters only (no prompt content — same
// data class as document_access/mcp_access). Pre-064 the store returns [] (degrade-safe).
// tokens 0 with calls_count > 0 means "provider didn't report usage", never "free".

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { gateCustomerWorkspace } from '../lib/workspace-gates';
import { listLlmUsageRow } from '../dal/llm-usage-store';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { neonClient } from '../db/client';

export interface LlmUsageEnv extends AuthEnv {
  DATABASE_URL: string;
}
export interface LlmUsageVariables extends AuthVariables {
  dal: DalAdapter;
  /** optional injectable Sql (tests) — falls back to neonClient(env.DATABASE_URL). */
  sql?: ReturnType<typeof neonClient>;
}

export const llmUsageRoute = new Hono<{ Bindings: LlmUsageEnv; Variables: LlmUsageVariables }>();

// GET /api/v1/llm-usage?limit=200
llmUsageRoute.get('/llm-usage', async (ctx) => {
  try {
    const gate = await gateCustomerWorkspace(ctx as never, { governedAction: 'token:read', deniedMessage: 'LLM usage requires the workspace owner or an operator' });
    if (!gate.ok) return gate.res;
    const ws = gate.ws;

    const sql = ctx.get('sql') ?? neonClient(ctx.env.DATABASE_URL);
    const limitRaw = Number(ctx.req.query('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 200;

    const entries = await listLlmUsageRow(sql, ws, limit);
    return ctx.json(withDataClass({ ok: true, workspace_id: ws, kind: 'llm_usage', entries }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
