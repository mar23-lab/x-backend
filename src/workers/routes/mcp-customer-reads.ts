// mcp-customer-reads.ts · T4/P7 (260710) · the tenant-scoped CUSTOMER-DATA read surface over MCP.
//
// The spine surface (packets/evidence-write/tool-events/approvals/status) was complete; the customer-data
// READS were absent — an MCP agent could report a tool event but couldn't ask "which sources are connected?"
// or "show my receipts". These 4 tools close that, READS ONLY (operator decision 260710: the sign-off WRITE
// waits for a contract-confirm — F14 discipline).
//
// TENANT-SAFE BY CONSTRUCTION: every read is bound to auth.workspace_id (the verified JWT / customer-token
// binding) — never a caller-supplied workspace. FORBIDDEN_SURFACES are untouched (no raw graph, no
// full-tenant memory, no secrets). Receipts ride the D-8 CONSERVATIVE redaction verbatim (non-member actors
// → 'xlooop:operator', free-text reason omitted). Documents return METADATA ONLY — never extracted_text.
// Mounted from mcp-gateway.ts (same /api/v1/mcp namespace + auth plane); tools listed in SAFE_TOOLS.

import { Hono } from 'hono';
import { errorEnvelope, clientError } from '../middleware/error';
import { neonClient } from '../db/client';
import { listWorkspaceSourcesRow } from '../dal/source-store';
import { listDocumentsRow } from '../lib/document-store';
import { listWorkspaceAuditLogRow, listWorkspaceMemberIdsRow } from '../dal/customer-audit-store';
import { redactAuditActorForCustomer } from '../lib/audit-export';
import { recordMcpRead } from '../dal/mcp-access-store';
import { envFlagTrue } from '../lib/env-flag';
import { emitEvent } from '../lib/observability';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';

export interface McpCustomerReadsEnv extends AuthEnv {
  DATABASE_URL: string;
  /** L2 (260710-D) · day-grain audit of these tenant reads into mcp_access_log (063; default off). */
  MCP_READ_AUDIT_ENABLED?: string;
}
export interface McpCustomerReadsVariables extends AuthVariables {
  dal: DalAdapter;
  sql?: ReturnType<typeof neonClient>; // injectable seam (tests)
}

export const mcpCustomerReadsRoute = new Hono<{ Bindings: McpCustomerReadsEnv; Variables: McpCustomerReadsVariables }>();

function ws(ctx: { get: (k: 'auth') => { workspace_id?: string } }): string {
  return String(ctx.get('auth')?.workspace_id || '').trim();
}
function sqlFor(ctx: { get: (k: 'sql') => unknown; env: { DATABASE_URL: string } }) {
  return (ctx.get('sql') as ReturnType<typeof neonClient> | undefined) ?? neonClient(ctx.env.DATABASE_URL);
}

/** L2 (260710-D) · day-grain read audit for these tenant reads (059/D4 pattern at tool grain, mig 063).
 *  Flag-gated (MCP_READ_AUDIT_ENABLED, default off ⇒ zero writes, no sql client built); fire-and-forget —
 *  a read is NEVER slowed or failed by its audit. Actor = the verified auth principal (instrument 'agent'). */
type AuditableCtx = {
  get: (k: never) => unknown;
  env: { DATABASE_URL: string; MCP_READ_AUDIT_ENABLED?: string };
  executionCtx?: { waitUntil: (p: Promise<unknown>) => void };
};
function auditRead(ctx: AuditableCtx, tool: string): void {
  try {
    const workspace = ws(ctx as never);
    const actor = String((ctx.get('auth' as never) as { user_id?: string })?.user_id || '').trim();
    recordMcpRead({
      enabled: envFlagTrue(ctx.env.MCP_READ_AUDIT_ENABLED),
      makeSql: () => sqlFor(ctx as never),
      workspaceId: workspace,
      tool,
      actorId: actor,
      waitUntil: (p) => {
        try { ctx.executionCtx?.waitUntil ? ctx.executionCtx.waitUntil(p) : void p.catch(() => {}); }
        catch { void p.catch(() => {}); } // test/non-workers runtimes have no executionCtx — fire anyway
      },
    });
    if (envFlagTrue(ctx.env.MCP_READ_AUDIT_ENABLED)) emitEvent('mcp_customer_read', { workspace_id: workspace, tool });
  } catch { /* audit is best-effort — never surfaces to the read */ }
}

// xlooop.list_sources · GET /api/v1/mcp/sources — workspace-bound connection/sync state (metadata only).
mcpCustomerReadsRoute.get('/sources', async (ctx) => {
  try {
    const workspace = ws(ctx as never);
    if (!workspace) return clientError(ctx, 403, 'FORBIDDEN', 'no workspace binding');
    auditRead(ctx as never, 'list_sources');
    const rows = await listWorkspaceSourcesRow(sqlFor(ctx as never), workspace).catch(() => []);
    return ctx.json({
      schema_id: 'xlooop.mcp_source_list.v1',
      sources: rows.map((r) => ({
        provider: r.provider, status: r.status, workspace_id: r.workspace_id,
        connected_at: r.connected_at, last_sync_at: r.last_sync_at, last_sync_error: r.last_sync_error,
        scopes: r.scopes,
      })),
    });
  } catch (err) { return errorEnvelope(ctx, err); }
});

// xlooop.get_evidence · GET /api/v1/mcp/evidence?packet_id= — workspace-scoped evidence lookup.
mcpCustomerReadsRoute.get('/evidence', async (ctx) => {
  try {
    const workspace = ws(ctx as never);
    if (!workspace) return clientError(ctx, 403, 'FORBIDDEN', 'no workspace binding');
    const packet_id = new URL(ctx.req.url).searchParams.get('packet_id') || undefined;
    if (!packet_id) return clientError(ctx, 400, 'VALIDATION_ERROR', 'packet_id query parameter is required');
    auditRead(ctx as never, 'get_evidence');
    const evidence = await ctx.get('dal').listEvidenceItems(workspace, { packet_id, limit: 100 });
    return ctx.json({ schema_id: 'xlooop.mcp_evidence_list.v1', packet_id, evidence });
  } catch (err) { return errorEnvelope(ctx, err); }
});

// xlooop.list_receipts · GET /api/v1/mcp/receipts?limit= — the D-8-redacted audit trail (same rules as
// GET /customer-audit-log: non-member actors → 'xlooop:operator'; free-text reason NEVER included).
mcpCustomerReadsRoute.get('/receipts', async (ctx) => {
  try {
    const workspace = ws(ctx as never);
    if (!workspace) return clientError(ctx, 403, 'FORBIDDEN', 'no workspace binding');
    const limitRaw = Number(new URL(ctx.req.url).searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
    auditRead(ctx as never, 'list_receipts');
    const sql = sqlFor(ctx as never);
    const [rows, memberIds] = await Promise.all([
      listWorkspaceAuditLogRow(sql, workspace, limit),
      listWorkspaceMemberIdsRow(sql, workspace),
    ]);
    return ctx.json({
      schema_id: 'xlooop.mcp_receipt_list.v1',
      receipts: rows.map((r) => ({
        occurred_at: r.occurred_at,
        actor: redactAuditActorForCustomer(r.actor_user_id, memberIds),
        action: r.action, target_type: r.target_type, target_id: r.target_id, causation_id: r.causation_id,
      })),
    });
  } catch (err) { return errorEnvelope(ctx, err); }
});

// xlooop.get_document · GET /api/v1/mcp/documents — METADATA ONLY (id/filename/admissibility/hash/created);
// extracted_text NEVER crosses this surface (content stays behind the governed chat-grounding plane).
mcpCustomerReadsRoute.get('/documents', async (ctx) => {
  try {
    const workspace = ws(ctx as never);
    if (!workspace) return clientError(ctx, 403, 'FORBIDDEN', 'no workspace binding');
    auditRead(ctx as never, 'get_document');
    // RLS-1 (J-W4 260711-I): route the document read through the RLS-subject client (046) exactly like
    // the first-party routes/documents.ts:191, so the agent-facing MCP surface engages the RLS 2nd layer
    // too. Preserves the test seam (ctx.get('sql')); falls back to owner DATABASE_URL when RLS not bound.
    const rlsEnv = ctx.env as { XLOOOP_RLS_APP_DATABASE_URL?: string; DATABASE_URL?: string };
    const docSql = (ctx.get('sql') as ReturnType<typeof neonClient> | undefined)
      ?? neonClient(rlsEnv.XLOOOP_RLS_APP_DATABASE_URL || rlsEnv.DATABASE_URL);
    const docs = await listDocumentsRow(docSql, workspace).catch(() => []);
    return ctx.json({
      schema_id: 'xlooop.mcp_document_list.v1',
      documents: (docs as Array<Record<string, unknown>>).map((d) => ({
        id: d.id, filename: d.filename, admissibility: d.admissibility ?? null,
        content_hash: d.content_hash ?? null, created_at: d.created_at ?? null,
      })),
    });
  } catch (err) { return errorEnvelope(ctx, err); }
});
