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
      -- 260805 · occurred_at, NOT created_at. public.audit_logs has never had a created_at column
      -- (002_entitlement_gate.sql:91-105 defines occurred_at), so this statement raised
      -- 'column "created_at" does not exist' on EVERY call — and the catch below turned that into a
      -- clean empty export. governance-store.ts:364 reads the same table correctly; this store was
      -- the lone outlier.
      SELECT occurred_at, actor_user_id, action, target_type, target_id, causation_id
      FROM audit_logs WHERE workspace_id = ${ws}
      ORDER BY occurred_at DESC LIMIT ${cap}
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      occurred_at: r.occurred_at == null ? null : new Date(r.occurred_at as string).toISOString(),
      actor_user_id: r.actor_user_id == null ? null : String(r.actor_user_id),
      action: String(r.action ?? ''),
      target_type: r.target_type == null ? null : String(r.target_type),
      target_id: r.target_id == null ? null : String(r.target_id),
      causation_id: r.causation_id == null ? null : String(r.causation_id),
    }));
  } catch (err) {
    // 260805 · DO NOT return [] on a SCHEMA error. The bare `catch { return []; }` here is what made
    // the column bug above invisible for its entire life: the route answered HTTP 200 with a
    // header-only CSV and a zero-byte JSONL, and `xlooop.list_receipts` answered `receipts: []`,
    // while production held 1,043 / 63 / 7 / 5 audit rows across four customer workspaces — 100%
    // omitted. An empty audit export is indistinguishable from "you have no audit history", which is
    // the worst possible lie for this particular surface: it is the record a customer reaches for
    // when they need to prove what happened.
    //
    // A missing column is a DEFECT, not an empty result set. Surface it so the route fails loudly
    // and Sentry sees it; genuine emptiness still returns [] from the query itself.
    const message = err instanceof Error ? err.message : String(err);
    if (/does not exist|undefined_column|42703/i.test(message)) throw err;
    return [];
  }
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
