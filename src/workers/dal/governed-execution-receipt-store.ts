import { assertWorkspaceScope } from './DalAdapter';
import { withWorkspaceRlsContext } from './operational-spine-store';
import type { Sql } from '../db/client';
import type { GovernedExecutionReceipt, WorkspaceId } from './types';

export async function countGovernedExecutionReceiptsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
): Promise<number> {
  assertWorkspaceScope(workspaceId);
  const [rows] = await withWorkspaceRlsContext<[Array<{ receipt_count: number | string }>]>(
    sql,
    workspaceId,
    (tx) => [tx/*sql*/`
      SELECT count(*)::integer AS receipt_count
        FROM governed_execution_receipts
       WHERE workspace_id = ${workspaceId}
    `],
    { readOnly: true },
  );
  return Number(rows[0]?.receipt_count ?? 0);
}

export async function listGovernedExecutionReceiptsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  limit = 200,
): Promise<GovernedExecutionReceipt[]> {
  assertWorkspaceScope(workspaceId);
  const boundedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 200, 200));
  const [rows] = await withWorkspaceRlsContext<[GovernedExecutionReceipt[]]>(
    sql,
    workspaceId,
    (tx) => [tx/*sql*/`
      SELECT id, workspace_id, resolution_id, actor_user_id, client_request_id, interaction_id,
        operation, target_type, target_id, result, effect_summary,
        closing_attestation_id, intent_id, operation_event_id, audit_event_id,
        projection_outbox_id, conversation_message_id, created_at
        FROM governed_execution_receipts
       WHERE workspace_id = ${workspaceId}
       ORDER BY created_at DESC
       LIMIT ${boundedLimit}
    `],
    { readOnly: true },
  );
  return rows.map((row) => ({
    ...row,
    closing_attestation_id: row.closing_attestation_id ?? null,
    intent_id: row.intent_id ?? null,
    operation_event_id: row.operation_event_id ?? null,
    audit_event_id: row.audit_event_id ?? null,
    projection_outbox_id: row.projection_outbox_id ?? null,
    conversation_message_id: row.conversation_message_id == null ? null : String(row.conversation_message_id),
  }));
}
