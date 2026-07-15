import { assertWorkspaceScope } from './DalAdapter';
import { withWorkspaceRlsContext } from './operational-spine-store';
import type { Sql } from '../db/client';
import type { UserId, WorkspaceId } from './types';

export type ModelExecutionProvider = 'anthropic' | 'workers_ai';
export type ModelExecutionStatus = 'completed' | 'fallback' | 'failed';

export interface ModelExecutionStartInput {
  resolution_id: string;
  context_packet_id: string;
  action: string;
  provider: ModelExecutionProvider;
  model_key: string;
}

export interface ModelExecutionFinishInput {
  status: ModelExecutionStatus;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number;
  error_code: string | null;
}

export async function startModelExecutionReceiptRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  principalId: UserId,
  input: ModelExecutionStartInput,
): Promise<string> {
  assertWorkspaceScope(workspaceId);
  const id = `mer_${crypto.randomUUID()}`;
  const [rows] = await withWorkspaceRlsContext<[Array<{ id: string }>]>(sql, workspaceId, (tx) => [tx/*sql*/`
    INSERT INTO model_execution_receipts (
      id, workspace_id, principal_id, resolution_id, context_packet_id, action, provider, model_key, status
    )
    SELECT ${id}, ${workspaceId}, ${principalId}, r.id, c.id, ${input.action}, ${input.provider}, ${input.model_key}, 'started'
      FROM role_skill_resolutions r
      JOIN context_packets c
        ON c.receipt_ref = r.id
       AND c.workspace_id = r.workspace_id
       AND c.principal_id = r.principal_id
     WHERE r.id = ${input.resolution_id}
       AND c.id = ${input.context_packet_id}
       AND r.workspace_id = ${workspaceId}
       AND r.principal_id = ${principalId}
    RETURNING id
  `]);
  if (!rows[0]) throw new Error('model execution context lineage is invalid');
  return rows[0].id;
}

export async function finishModelExecutionReceiptRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  receiptId: string,
  input: ModelExecutionFinishInput,
): Promise<void> {
  assertWorkspaceScope(workspaceId);
  const [rows] = await withWorkspaceRlsContext<[Array<{ id: string }>]>(sql, workspaceId, (tx) => [tx/*sql*/`
    UPDATE model_execution_receipts
       SET status = ${input.status}, tokens_in = ${input.tokens_in}, tokens_out = ${input.tokens_out},
           latency_ms = ${input.latency_ms}, error_code = ${input.error_code}, completed_at = now()
     WHERE id = ${receiptId} AND workspace_id = ${workspaceId} AND status = 'started'
    RETURNING id
  `]);
  if (!rows[0]) throw new Error('model execution receipt could not be finalized');
}
