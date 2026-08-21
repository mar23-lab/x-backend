import type { Sql } from '../db/client';
import { makeError } from './shared-helpers';

export const WORKSPACE_RELATIONSHIP_STATUSES = [
  'internal_dogfood',
  'customer_zero',
  'external_evaluation',
  'pilot_candidate',
  'pilot_contracted',
  'customer_active',
  'customer_inactive',
  'commercial_partner',
  'technology_partner',
  'vendor',
  'archived',
] as const;

export type WorkspaceRelationshipStatus = typeof WORKSPACE_RELATIONSHIP_STATUSES[number];

export interface WorkspaceRelationshipTransitionInput {
  relationship_status: WorkspaceRelationshipStatus;
  expected_current_status: WorkspaceRelationshipStatus;
  actor_user_id: string;
  request_id: string;
  reason: string;
}

export interface WorkspaceRelationshipTransitionReceipt {
  workspace_id: string;
  previous_status: WorkspaceRelationshipStatus;
  relationship_status: WorkspaceRelationshipStatus;
  audit_id: string;
  occurred_at: string;
}

export async function transitionWorkspaceRelationshipStatusRow(
  sql: Sql,
  workspaceIdInput: string,
  input: WorkspaceRelationshipTransitionInput,
): Promise<WorkspaceRelationshipTransitionReceipt> {
  const workspaceId = String(workspaceIdInput || '').trim();
  const actorUserId = String(input.actor_user_id || '').trim();
  const requestId = String(input.request_id || '').trim();
  const reason = String(input.reason || '').trim();
  if (!workspaceId || !actorUserId || !requestId || reason.length < 8 || reason.length > 500) {
    throw makeError('VALIDATION_ERROR', 'workspace_id, actor_user_id, request_id, and reason (8-500 chars) are required', 400);
  }
  if (!WORKSPACE_RELATIONSHIP_STATUSES.includes(input.relationship_status)
    || !WORKSPACE_RELATIONSHIP_STATUSES.includes(input.expected_current_status)) {
    throw makeError('VALIDATION_ERROR', 'invalid workspace relationship status', 400);
  }
  if (input.relationship_status === input.expected_current_status) {
    throw makeError('VALIDATION_ERROR', 'new relationship_status must differ from expected_current_status', 400);
  }

  const metadata = JSON.stringify({
    schema_id: 'xlooop.workspace_relationship_transition_receipt.v1',
    request_id: requestId,
    previous_status: input.expected_current_status,
    relationship_status: input.relationship_status,
  });
  const rows = await sql/*sql*/`
    WITH current_workspace AS (
      SELECT id, relationship_status
      FROM workspaces
      WHERE id = ${workspaceId}
      FOR UPDATE
    ), transitioned AS (
      UPDATE workspaces AS workspace
      SET relationship_status = ${input.relationship_status}, updated_at = now()
      FROM current_workspace
      WHERE workspace.id = current_workspace.id
        AND current_workspace.relationship_status = ${input.expected_current_status}
      RETURNING workspace.id, workspace.relationship_status
    ), audit_receipt AS (
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, workspace_id, reason, metadata
      )
      SELECT ${actorUserId}, 'workspace_relationship_transition', 'workspace',
        transitioned.id, transitioned.id, ${reason}, ${metadata}::jsonb
      FROM transitioned
      RETURNING id::text, occurred_at
    )
    SELECT current_workspace.id AS workspace_id,
      current_workspace.relationship_status AS previous_status,
      transitioned.relationship_status,
      audit_receipt.id AS audit_id,
      audit_receipt.occurred_at
    FROM current_workspace
    LEFT JOIN transitioned ON transitioned.id = current_workspace.id
    LEFT JOIN audit_receipt ON true
  ` as Array<{
    workspace_id: string;
    previous_status: WorkspaceRelationshipStatus;
    relationship_status: WorkspaceRelationshipStatus | null;
    audit_id: string | null;
    occurred_at: string | null;
  }>;

  const row = rows[0];
  if (!row) throw makeError('NOT_FOUND', `workspace ${workspaceId} not found`, 404);
  if (!row.relationship_status || !row.audit_id || !row.occurred_at) {
    throw makeError(
      'CONFLICT',
      `workspace ${workspaceId} relationship status is ${row.previous_status}; expected ${input.expected_current_status}`,
      409,
    );
  }
  return {
    workspace_id: row.workspace_id,
    previous_status: row.previous_status,
    relationship_status: row.relationship_status,
    audit_id: row.audit_id,
    occurred_at: row.occurred_at,
  };
}
