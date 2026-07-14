// chat-receipt.ts · W2 customer-governance wave (260708) · G4-read — the per-answer AUDIT RECEIPT.
//
// Every AI answer persisted with grounding links (W1, migration 058) is retrievable as a receipt: WHAT the
// answer said, WHEN, and — re-read LIVE through the caller's role visibility — WHICH operation_events
// grounded it. The frozen `grounded_on` snapshot shows what the model saw at answer time; the live re-read
// shows those events as they are NOW (status changes visible). This is the regulated-SMB "why did the agent
// say X" answer, exportable (CSV/JSONL via the frozen RECEIPT_EXPORT_COLUMNS).
//
// CONSERVATIVE REDACTION (operator decision 260708): `generated_by` exposes only llm|deterministic — NO
// model/vendor names (the "via Xlooop" doctrine); events carry `instrument_kind` (agent-vs-human, 050) but
// never the principal id (A-W4.1 redaction owns that). G7 honesty: each event carries `lineage_recorded` —
// false = a pre-050 row whose actor lineage was never captured (annotated, never backfilled).
//
// TENANT-SAFE: the receipt's thread workspace MUST equal the verified JWT workspace; a foreign or unknown
// receipt_uid returns the SAME 404 (cross-tenant probing is indistinguishable from absence). Events are
// re-read via the role-visibility path (dal.listEvents with the caller's role) — a receipt can never leak
// an event the caller's role could not read directly.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { getMessageByReceiptUidRow } from '../dal/chat-store';
import { RECEIPT_EXPORT_COLUMNS, rowsToCsv, rowsToJsonl, parseAuditExportFormat } from '../lib/audit-export';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { neonClient } from '../db/client';

export interface ChatReceiptEnv extends AuthEnv {
  DATABASE_URL: string;
}
export interface ChatReceiptVariables extends AuthVariables {
  dal: DalAdapter;
  /** optional injectable Sql (tests) — falls back to neonClient(env.DATABASE_URL). */
  sql?: ReturnType<typeof neonClient>;
}

export const chatReceiptRoute = new Hono<{ Bindings: ChatReceiptEnv; Variables: ChatReceiptVariables }>();

// GET /api/v1/chat/receipt/:receipt_uid?format=json|csv|jsonl
chatReceiptRoute.get('/chat/receipt/:receipt_uid', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const dal = ctx.get('dal');
    const ws = String(auth.workspace_id || '').trim();
    const notFound = () => { ctx.status(404); return ctx.json({ error: 'receipt not found', code: 'NOT_FOUND', request_id: ctx.get('request_id') }); };
    if (!ws) { ctx.status(403); return ctx.json({ error: 'no signed-in workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') }); }

    const sql = ctx.get('sql') ?? neonClient(ctx.env.DATABASE_URL);
    const msg = await getMessageByReceiptUidRow(sql, ctx.req.param('receipt_uid'));
    // TENANT GATE: absent + foreign-workspace are the SAME 404 (no cross-tenant existence oracle).
    if (!msg || msg.workspace_id !== ws) return notFound();

    // Re-read the grounding events LIVE through the caller's role visibility (the same listEvents path every
    // read uses) — the receipt can never widen what the role could read. ≤200 ids (the W1 cap).
    const wantIds = new Set((msg.grounding_event_ids ?? []).slice(0, 200));
    let liveEvents: Array<Record<string, unknown>> = [];
    if (wantIds.size) {
      try {
        const page = await dal.listEvents(ws, { limit: 200, role: auth.role } as never) as unknown as { events?: Array<Record<string, unknown>> };
        liveEvents = (page.events ?? []).filter((e) => wantIds.has(String(e.id)));
      } catch { liveEvents = []; }
    }
    const rows = liveEvents.map((e) => ({
      event_id: String(e.id),
      occurred_at: e.occurred_at ?? null,
      status: e.status ?? null,
      summary: e.summary ?? null,
      source_tool: e.source_tool ?? null,
      instrument_kind: e.instrument_kind ?? null, // agent-vs-human (050); principal id stays redacted upstream
      lineage_recorded: e.authorized_by_user_id != null || e.instrument_kind != null, // G7 annotation
    }));

    const format = parseAuditExportFormat(ctx.req.query('format'));
    if (format === 'csv') {
      ctx.header('Content-Type', 'text/csv; charset=utf-8');
      ctx.header('Content-Disposition', 'attachment; filename="chat-receipt.csv"');
      return ctx.body(rowsToCsv(RECEIPT_EXPORT_COLUMNS, rows));
    }
    if (format === 'jsonl') {
      ctx.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      ctx.header('Content-Disposition', 'attachment; filename="chat-receipt.jsonl"');
      return ctx.body(rowsToJsonl(RECEIPT_EXPORT_COLUMNS, rows));
    }
    return ctx.json(withDataClass({
      ok: true,
      receipt: {
        answered_at: msg.created_at,
        mode: msg.mode,
        generated_by: msg.generated_by === 'llm' ? 'llm' : 'deterministic', // NEVER a model/vendor name
        answer: msg.body,
        grounded_on: msg.grounded_on,          // the FROZEN what-the-model-saw snapshot
        grounding_event_ids: [...wantIds],
        live_events: rows,                     // the same events as they are NOW (role-visibility-filtered)
        live_events_visible: rows.length,      // may be < ids: visibility/archival can hide some — honest count
      },
    }, 'live'));
  } catch (err) { return errorEnvelope(ctx, err); }
});
