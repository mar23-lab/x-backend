// customer-audit-store.ts · W2 (260708) · G8 — the customer-scoped audit_logs read.
//
// The operator audit trail (listGovernanceAuditLogForOperator) spans the operator's workspaces; this is the
// TENANT variant: strictly ONE workspace (the verified JWT's), newest first, degrade-to-empty. Redaction is
// the ROUTE's job (redactAuditActorForCustomer — conservative policy); this read returns raw rows plus the
// workspace's member ids so the route can distinguish "your teammate" from "xlooop operator".

import type { Sql } from '../db/client';

export interface CustomerAuditRow {
  occurred_at: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  causation_id: string | null;
}

export async function listWorkspaceAuditLogRow(sql: Sql, workspaceId: string, limit = 100): Promise<CustomerAuditRow[]> {
  const ws = String(workspaceId || '').trim();
  if (!ws) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  try {
    const rows = (await sql/*sql*/`
      SELECT created_at AS occurred_at, actor_user_id, action, target_type, target_id, causation_id
      FROM audit_logs WHERE workspace_id = ${ws}
      ORDER BY created_at DESC LIMIT ${cap}
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      occurred_at: r.occurred_at == null ? null : new Date(r.occurred_at as string).toISOString(),
      actor_user_id: r.actor_user_id == null ? null : String(r.actor_user_id),
      action: String(r.action ?? ''),
      target_type: r.target_type == null ? null : String(r.target_type),
      target_id: r.target_id == null ? null : String(r.target_id),
      causation_id: r.causation_id == null ? null : String(r.causation_id),
    }));
  } catch { return []; }
}

/** The workspace's ACTIVE member ids (for actor redaction: teammates pass through, others → xlooop:operator). */
export async function listWorkspaceMemberIdsRow(sql: Sql, workspaceId: string): Promise<Set<string>> {
  const ws = String(workspaceId || '').trim();
  if (!ws) return new Set();
  try {
    const rows = (await sql/*sql*/`
      SELECT user_id FROM workspace_members WHERE workspace_id = ${ws} AND status = 'active'
    `) as Array<Record<string, unknown>>;
    return new Set(rows.map((r) => String(r.user_id)));
  } catch { return new Set(); }
}
