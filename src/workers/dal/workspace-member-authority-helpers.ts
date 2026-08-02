import type {
  UserId,
  WorkspaceId,
  WorkspaceMemberMutationIdempotencyInput,
  WorkspaceMemberRoleMutationReceipt,
  WorkspaceMemberRemovalReceipt,
} from './types';
import type { Sql } from '../db/client';
import { makeError } from './shared-helpers';

export type MemberMutationReceipt = WorkspaceMemberRoleMutationReceipt | WorkspaceMemberRemovalReceipt;

export function cleanMemberMutationValue(value: unknown): string {
  return String(value ?? '').trim();
}

export function memberMutationReceiptFromBody(
  body: unknown,
  kind: 'role' | 'remove',
  replayed: boolean,
): MemberMutationReceipt {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw makeError('INTERNAL_ERROR', 'strict member mutation replay body is unavailable', 500);
  }
  const row = body as Partial<MemberMutationReceipt>;
  const targetComplete = kind === 'role'
    ? Boolean((row as Partial<WorkspaceMemberRoleMutationReceipt>).member?.user_id)
    : Boolean((row as Partial<WorkspaceMemberRemovalReceipt>).removed?.user_id);
  if (!targetComplete || !row.member_mutation_receipt_id || !row.operation_event_id
    || !row.audit_event_id || !row.projection_outbox_id || !row.read_model_watermark) {
    throw makeError('INTERNAL_ERROR', 'strict member mutation replay body is incomplete', 500);
  }
  return { ...row, replayed } as MemberMutationReceipt;
}

export function validateMemberMutationIdempotency(
  idempotency: WorkspaceMemberMutationIdempotencyInput,
  expectedRoute: WorkspaceMemberMutationIdempotencyInput['route'],
): void {
  const key = cleanMemberMutationValue(idempotency.key);
  if (!key || key.length > 200) {
    throw makeError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required (1-200 chars)', 428);
  }
  if (!/^[a-f0-9]{64}$/.test(idempotency.request_sha256)) {
    throw makeError('VALIDATION_ERROR', 'request_sha256 must be a lower-case SHA-256 value', 400);
  }
  if (idempotency.route !== expectedRoute) {
    throw makeError('VALIDATION_ERROR', 'strict member mutation route identity is invalid', 400);
  }
}

export async function findStrictMemberMutationReplay(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  idempotency: WorkspaceMemberMutationIdempotencyInput,
  kind: 'role' | 'remove',
): Promise<MemberMutationReceipt | null> {
  const rows = (await sql/*sql*/`
    SELECT request_sha256, response_status, response_body
    FROM idempotency_keys
    WHERE workspace_id = ${workspaceId}
      AND actor_user_id = ${actorUserId}
      AND route = ${idempotency.route}
      AND idempotency_key = ${idempotency.key}
      AND mode = 'authority_strict'
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  if (row.request_sha256 !== idempotency.request_sha256) {
    throw makeError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request', 409);
  }
  if (row.response_status == null || row.response_body == null) {
    throw makeError('MEMBER_ATOMICITY_FAILED', 'member mutation has no durable authority result', 500);
  }
  return memberMutationReceiptFromBody(row.response_body, kind, true);
}

export async function readStrictMemberMutationReplay(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  idempotency: WorkspaceMemberMutationIdempotencyInput,
  kind: 'role' | 'remove',
): Promise<MemberMutationReceipt> {
  const replay = await findStrictMemberMutationReplay(sql, workspaceId, actorUserId, idempotency, kind);
  if (!replay) throw makeError('INTERNAL_ERROR', 'strict member mutation did not create a replay record', 500);
  return replay;
}
