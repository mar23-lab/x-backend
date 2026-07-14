// feedback.ts · T6 (260710) · the Test-mode feedback channel's backend (operator scope 260710).
//
//   POST /api/v1/feedback  — a provisioned member submits an annotation (any role: feedback is a
//                            contribution, not a governed write). Flag FEEDBACK_PERSISTENCE_ENABLED,
//                            default OFF → 409 (inert-by-default, the token-minter pattern).
//   GET  /api/v1/feedback  — owner/operator-class read (the operator triages what testers filed).
//
// TENANT-SAFE BY CONSTRUCTION: workspace only ever from the verified JWT (gateCustomerWorkspace).
// Day-cap 50/user/day (429). Audited best-effort (audit_logs 'feedback_submitted', target 'workspace').

import { Hono } from 'hono';
import { envFlagTrue } from '../lib/env-flag';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { gateCustomerWorkspace } from '../lib/workspace-gates';
import { authorizeGovernedWrite } from '../lib/spine-authority';
import { insertFeedbackRow, countFeedbackTodayRow, listFeedbackRow } from '../dal/feedback-store';
import { emitEvent } from '../lib/observability';
import { neonClient } from '../db/client';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';

export interface FeedbackEnv extends AuthEnv {
  DATABASE_URL: string;
  FEEDBACK_PERSISTENCE_ENABLED?: string;
}
export interface FeedbackVariables extends AuthVariables {
  dal: DalAdapter;
  sql?: ReturnType<typeof neonClient>;
}

const DAY_CAP = 50;

export const feedbackRoute = new Hono<{ Bindings: FeedbackEnv; Variables: FeedbackVariables }>();

feedbackRoute.post('/feedback', async (ctx) => {
  try {
    if (!envFlagTrue(ctx.env.FEEDBACK_PERSISTENCE_ENABLED)) {
      ctx.status(409);
      return ctx.json({ error: 'feedback persistence is not enabled for this deployment yet', code: 'CONFLICT', request_id: ctx.get('request_id') });
    }
    const gate = await gateCustomerWorkspace(ctx as never);
    if (!gate.ok) return gate.res;
    const auth = ctx.get('auth');

    const body = (await ctx.req.json().catch(() => null)) as { body?: string; target_label?: string; page?: string; mode?: string } | null;
    const text = typeof body?.body === 'string' ? body.body.trim() : '';
    if (!text || text.length > 2000) {
      ctx.status(400);
      return ctx.json({ error: 'body.body required (1-2000 chars)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const sql = ctx.get('sql') ?? neonClient(ctx.env.DATABASE_URL);
    if ((await countFeedbackTodayRow(sql, gate.ws, auth.user_id)) >= DAY_CAP) {
      ctx.status(429);
      return ctx.json({ error: `feedback day cap reached (${DAY_CAP}/day)`, code: 'RATE_LIMITED', request_id: ctx.get('request_id') });
    }
    const row = await insertFeedbackRow(sql, {
      workspace_id: gate.ws,
      user_id: auth.user_id,
      body: text,
      target_label: typeof body?.target_label === 'string' ? body.target_label.slice(0, 200) : null,
      page: typeof body?.page === 'string' ? body.page.slice(0, 200) : null,
      mode: typeof body?.mode === 'string' && body.mode ? body.mode.slice(0, 20) : 'test',
    });
    // best-effort audit mirror — a failed audit never blocks the submission, but the loss is logged
    try {
      await gate.dal.appendAuditLog({
        actor_user_id: auth.user_id,
        action: 'feedback_submitted',
        target_type: 'workspace',
        target_id: gate.ws,
        workspace_id: gate.ws,
        metadata: { feedback_id: row.id, page: row.page, request_id: ctx.get('request_id') },
      });
    } catch (err) {
      console.warn('[feedback] audit mirror failed (best-effort)', { workspace_id: gate.ws, error: (err as Error)?.message });
    }
    emitEvent('feedback_submitted', { workspace_id: gate.ws, feedback_id: row.id, mode: row.mode });
    ctx.status(201);
    return ctx.json(withDataClass({ ok: true, feedback_id: row.id, status: row.status }, 'live'));
  } catch (err) { return errorEnvelope(ctx, err); }
});

feedbackRoute.get('/feedback', async (ctx) => {
  try {
    const gate = await gateCustomerWorkspace(ctx as never);
    if (!gate.ok) return gate.res;
    // Operator triage surface: owner/operator-class (flag-off ≡ canWrite; flag-on one-core authority).
    if (!(await authorizeGovernedWrite(ctx as never, 'token:read')).allowed) {
      ctx.status(403);
      return ctx.json({ error: 'the feedback list requires the workspace owner or an operator', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const sql = ctx.get('sql') ?? neonClient(ctx.env.DATABASE_URL);
    const limitRaw = Number(ctx.req.query('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
    const entries = await listFeedbackRow(sql, gate.ws, limit);
    return ctx.json(withDataClass({ ok: true, workspace_id: gate.ws, entries }, 'live'));
  } catch (err) { return errorEnvelope(ctx, err); }
});
