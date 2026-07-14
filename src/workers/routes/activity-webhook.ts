// activity-webhook.ts · R54-Stage3-A · operator/agent activity producer
//
// THE SECOND REAL EVENT PRODUCER (after the GitHub webhook). Captures work that
// is NOT a git push — Claude Code sessions, Codex runs, operator decisions,
// harness milestones — into operation_events, so the cockpit reflects ALL daily
// work, not just commits. Closes the gap the operator named: "we are doing lots
// of work today" but only github/seed rows showed.
//
// Security model:
//   - PUBLIC route (a local CLI / Stop-hook can't present a Clerk JWT). The gate
//     is a shared-secret bearer token compared in constant time against the
//     dedicated ACTIVITY_INGEST_TOKEN worker secret (kept separate from the
//     governance push token so it can rotate independently). Missing secret →
//     503 (closed). Bad/absent token → 401 with ZERO DB writes.
//
// Attribution: each event's workspace is event.workspace_id (if given) else
// ACTIVITY_DEFAULT_WORKSPACE else GITHUB_WEBHOOK_DEFAULT_WORKSPACE. The workspace
// MUST be one the operator owns so Stage-2's operator-overlay surfaces it; an
// event with no resolvable workspace is rejected (never invent one).
//
// Idempotent: dal.upsertEvent skips ids that already exist, so re-posting the
// same activity (e.g. a retried hook) never duplicates.

import { Hono } from 'hono';
import { errorEnvelope, clientError } from '../middleware/error';
import { VALID_STATUSES, VALID_SOURCE_TOOLS } from '../lib/event-validation';
import type { AuthEnv } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { HarnessFlowEventInput, EventStatus, SourceTool } from '../dal/types';

export interface ActivityWebhookEnv extends AuthEnv {
  ACTIVITY_INGEST_TOKEN?: string;     // dedicated shared-secret bearer for activity ingest
  ACTIVITY_DEFAULT_WORKSPACE?: string;        // fallback workspace_id for activity events
  GITHUB_WEBHOOK_DEFAULT_WORKSPACE?: string;  // secondary fallback (shared with the gh webhook)
}

export interface ActivityWebhookVariables {
  dal: DalAdapter;
  request_id?: string;
}

export const activityWebhookRoute = new Hono<{ Bindings: ActivityWebhookEnv; Variables: ActivityWebhookVariables }>();

const MAX_BATCH = 200;

// constant-time bearer compare against the shared ingest secret.
function verifyActivityToken(env: ActivityWebhookEnv, authHeader: string): { ok: true } | { ok: false; status: 401 | 503; msg: string } {
  const secret = (env.ACTIVITY_INGEST_TOKEN || '').trim();
  if (!secret) return { ok: false, status: 503, msg: 'ACTIVITY_INGEST_TOKEN is not configured on this Worker' };
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token || token.length !== secret.length) return { ok: false, status: 401, msg: 'invalid or missing ingest token' };
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  if (diff !== 0) return { ok: false, status: 401, msg: 'invalid or missing ingest token' };
  return { ok: true };
}

// POST /api/v1/webhooks/activity
// Body: { events: [ { id, source_tool, summary, status?, occurred_at?, body?,
//   evidence_link?, project_id?, agent_id?, workspace_id? } ] }  (or a single event object)
activityWebhookRoute.post('/webhooks/activity', async (ctx) => {
  try {
    const auth = verifyActivityToken(ctx.env, ctx.req.header('Authorization') || ctx.req.header('authorization') || '');
    if (!auth.ok) {
      return clientError(ctx, auth.status, auth.status === 503 ? 'SERVICE_UNAVAILABLE' : 'UNAUTHORIZED', auth.msg);
    }

    const parsed = await ctx.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') {
      return clientError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    }
    const rawEvents = Array.isArray((parsed as { events?: unknown }).events)
      ? (parsed as { events: unknown[] }).events
      : [parsed]; // allow a single bare event object
    if (rawEvents.length === 0) {
      return clientError(ctx, 400, 'VALIDATION_ERROR', 'no events in request');
    }
    if (rawEvents.length > MAX_BATCH) {
      return clientError(ctx, 400, 'VALIDATION_ERROR', `batch too large (${rawEvents.length} > ${MAX_BATCH})`);
    }

    const defaultWs = String(ctx.env.ACTIVITY_DEFAULT_WORKSPACE || ctx.env.GITHUB_WEBHOOK_DEFAULT_WORKSPACE || '').trim();
    const dal = ctx.get('dal');
    const receipts: Array<{ id: string | null; ok: boolean; created?: boolean; reason?: string }> = [];
    let created = 0, skipped = 0, rejected = 0;

    for (const raw of rawEvents) {
      const e = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      const id = typeof e.id === 'string' ? e.id : '';
      const source_tool = e.source_tool as SourceTool;
      const summary = typeof e.summary === 'string' ? e.summary : '';
      const workspace_id = String((typeof e.workspace_id === 'string' && e.workspace_id) || defaultWs).trim();

      // Per-event validation — one bad event does not fail the whole batch.
      if (!id || id.length > 128) { receipts.push({ id: id || null, ok: false, reason: 'missing/invalid id' }); rejected++; continue; }
      if (!source_tool || !VALID_SOURCE_TOOLS.has(source_tool)) { receipts.push({ id, ok: false, reason: `invalid source_tool: ${String(e.source_tool)}` }); rejected++; continue; }
      if (!summary || summary.length > 512) { receipts.push({ id, ok: false, reason: 'missing/invalid summary (1-512 chars)' }); rejected++; continue; }
      if (!workspace_id) { receipts.push({ id, ok: false, reason: 'no workspace_id and no ACTIVITY_DEFAULT_WORKSPACE configured' }); rejected++; continue; }

      const status = (typeof e.status === 'string' && VALID_STATUSES.has(e.status as EventStatus)) ? e.status as EventStatus : 'completed';
      // occurred_at: use the caller's real timestamp; default to now (the honest
      // ingest time) ONLY when absent. Never fabricate a past time.
      const occurred_at = (typeof e.occurred_at === 'string' && e.occurred_at) ? e.occurred_at : new Date().toISOString();

      const input: HarnessFlowEventInput = {
        id,
        source_tool,
        status,
        summary,
        occurred_at,
        agent_id: typeof e.agent_id === 'string' ? e.agent_id : null,
        project_id: typeof e.project_id === 'string' ? e.project_id : null,
        // SEC-3 (J-W4 260711-I): this is a PUBLIC route gated only by the shared ingest token; clip body
        // + evidence_link so a token holder can't post 200 events each with an unbounded TEXT blob.
        body: typeof e.body === 'string' ? e.body.slice(0, 4000) : null,
        evidence_link: typeof e.evidence_link === 'string' ? e.evidence_link.slice(0, 2048) : null,
      };
      try {
        const r = await dal.upsertEvent(workspace_id, input);
        receipts.push({ id, ok: true, created: r.created });
        if (r.created) created++; else skipped++;
      } catch (err) {
        receipts.push({ id, ok: false, reason: err instanceof Error ? err.message : 'upsert failed' });
        rejected++;
      }
    }

    ctx.status(created > 0 ? 201 : 200);
    return ctx.json({
      _meta: { schema: 'xlooop.activity_ingest_receipt.v1', served_by: 'api.xlooop.com', served_at: new Date().toISOString() },
      ok: rejected === 0,
      counts: { received: rawEvents.length, created, skipped, rejected },
      receipts,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
