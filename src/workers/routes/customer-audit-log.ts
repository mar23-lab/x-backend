// customer-audit-log.ts · W2 customer-governance wave (260708) · G8 — the customer-scoped audit export.
//
// The governance audit trail (audit_logs, E2 export) has been operator-only. This gives a provisioned
// customer workspace its OWN trail — who did what, when, with the causation pointer — under the
// CONSERVATIVE redaction policy (operator decision 260708): actor identities that are NOT members of the
// caller's workspace render as 'xlooop:operator' (platform/system actors as 'xlooop:system'), and the
// free-text `reason` column is OMITTED entirely. Frozen CUSTOMER_AUDIT_EXPORT_COLUMNS; CSV/JSONL reuse the
// E2 serializers. OWNER/OPERATOR-role gated (an audit trail is a governance surface, not a viewer read).
// Tenant-safe by construction: the workspace is only ever the verified JWT's.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { gateCustomerWorkspace } from '../lib/workspace-gates';
import { listWorkspaceAuditLogRow, listWorkspaceMemberIdsRow } from '../dal/customer-audit-store';
import { CUSTOMER_AUDIT_EXPORT_COLUMNS, rowsToCsv, rowsToJsonl, parseAuditExportFormat, redactAuditActorForCustomer } from '../lib/audit-export';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { neonClient } from '../db/client';

export interface CustomerAuditLogEnv extends AuthEnv {
  DATABASE_URL: string;
}
export interface CustomerAuditLogVariables extends AuthVariables {
  dal: DalAdapter;
  /** optional injectable Sql (tests) — falls back to neonClient(env.DATABASE_URL). */
  sql?: ReturnType<typeof neonClient>;
}

export const customerAuditLogRoute = new Hono<{ Bindings: CustomerAuditLogEnv; Variables: CustomerAuditLogVariables }>();

// GET /api/v1/customer-audit-log?limit=100&format=json|csv|jsonl
customerAuditLogRoute.get('/customer-audit-log', async (ctx) => {
  try {
    // Provisioning + owner/operator-class governance gate — the shared lib/workspace-gates.ts driver
    // (S3 consolidation; same responses byte-for-byte as the previous inline block).
    const gate = await gateCustomerWorkspace(ctx as never, { governedAction: 'token:read', deniedMessage: 'the audit trail requires the workspace owner or an operator' });
    if (!gate.ok) return gate.res;
    const ws = gate.ws;

    const sql = ctx.get('sql') ?? neonClient(ctx.env.DATABASE_URL);
    const limitRaw = Number(ctx.req.query('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;

    // W4 · ?kind=document_access — the day-grain read-audit facet (migration 059): who accessed which
    // document, when (day), how often. Actors here are workspace members by construction (access is
    // recorded for the asking user), so rows pass through unredacted.
    if (ctx.req.query('kind') === 'document_access') {
      const { listDocumentAccessRow } = await import('../dal/document-access-store');
      const access = await listDocumentAccessRow(sql, ws, limit);
      return ctx.json(withDataClass({ ok: true, workspace_id: ws, kind: 'document_access', entries: access }, 'live'));
    }

    const [rows, memberIds] = await Promise.all([
      listWorkspaceAuditLogRow(sql, ws, limit),
      listWorkspaceMemberIdsRow(sql, ws),
    ]);
    // CONSERVATIVE redaction: teammates pass through; any non-member principal → 'xlooop:operator';
    // `reason` (free text) is never included.
    const entries = rows.map((r) => ({
      occurred_at: r.occurred_at,
      actor: redactAuditActorForCustomer(r.actor_user_id, memberIds),
      action: r.action,
      target_type: r.target_type,
      target_id: r.target_id,
      causation_id: r.causation_id,
    }));

    const format = parseAuditExportFormat(ctx.req.query('format'));
    if (format === 'csv') {
      ctx.header('Content-Type', 'text/csv; charset=utf-8');
      ctx.header('Content-Disposition', 'attachment; filename="workspace-audit-log.csv"');
      return ctx.body(rowsToCsv(CUSTOMER_AUDIT_EXPORT_COLUMNS, entries));
    }
    if (format === 'jsonl') {
      ctx.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      ctx.header('Content-Disposition', 'attachment; filename="workspace-audit-log.jsonl"');
      return ctx.body(rowsToJsonl(CUSTOMER_AUDIT_EXPORT_COLUMNS, entries));
    }
    return ctx.json(withDataClass({ ok: true, workspace_id: ws, entries }, 'live'));
  } catch (err) { return errorEnvelope(ctx, err); }
});
