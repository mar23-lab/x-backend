// customer-invite-store.ts · strict invitation delivery persistence

import { assertWorkspaceScope } from './DalAdapter';
import { makeError } from './shared-helpers';
import type { Sql } from '../db/client';
import type {
  CustomerInviteCommandInput,
  CustomerInviteCommandReservation,
  CustomerInviteDeliveryReceipt,
  CustomerInviteFailureInput,
  CustomerInviteFinalizeInput,
} from './types';

const INVITE_ROUTE = 'POST /api/v1/customer/invites' as const;

function validateInviteCommand(input: CustomerInviteCommandInput): void {
  if (!input?.workspace_id || !input?.actor_user_id || !input?.email?.trim()
    || !input.command_id || !input.lease_token || !input.key) {
    throw makeError(
      'VALIDATION_ERROR',
      'workspace_id, actor_user_id, email, command_id, lease_token and idempotency key are required',
      400,
    );
  }
  if (input.route !== INVITE_ROUTE || input.key.length > 200) {
    throw makeError('IDEMPOTENCY_KEY_REQUIRED', 'a valid invitation Idempotency-Key is required', 428);
  }
  if (!/^[a-f0-9]{64}$/.test(input.request_sha256)) {
    throw makeError('VALIDATION_ERROR', 'request_sha256 must be a lower-case SHA-256 value', 400);
  }
  assertWorkspaceScope(input.workspace_id);
}
function inviteReceiptFromBody(body: unknown, replayed: boolean): CustomerInviteDeliveryReceipt {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw makeError('INVITE_ATOMICITY_FAILED', 'invitation replay body is unavailable', 500);
  }
  const receipt = body as Partial<CustomerInviteDeliveryReceipt>;
  if (!receipt.invited?.invitation_id || !receipt.invited.email || !receipt.invited.role
    || !receipt.invite_receipt_id || !receipt.operation_event_id || !receipt.audit_event_id
    || !receipt.projection_outbox_id || !receipt.read_model_watermark
    || receipt.delivery_status !== 'delivered') {
    throw makeError('INVITE_ATOMICITY_FAILED', 'invitation authority envelope is incomplete', 500);
  }
  return { ...receipt, replayed } as CustomerInviteDeliveryReceipt;
}

export async function reserveCustomerInviteRow(
  sql: Sql,
  input: CustomerInviteCommandInput,
): Promise<CustomerInviteCommandReservation> {
  validateInviteCommand(input);
  const email = input.email.trim().toLowerCase();
  const pendingBody = JSON.stringify({
    state: 'pending_delivery',
    command_id: input.command_id,
    lease_token: input.lease_token,
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    email,
    clerk_role: input.clerk_role,
    workspace_role: input.workspace_role,
    requested_workspace_role: input.requested_workspace_role,
    role_basis: input.role_basis,
  });
  const inserted = (await sql/*sql*/`
    INSERT INTO idempotency_keys (
      workspace_id, idempotency_key, route, actor_user_id, request_sha256, mode,
      response_status, response_body, completed_at
    ) VALUES (
      ${input.workspace_id}, ${input.key}, ${input.route}, ${input.actor_user_id},
      ${input.request_sha256}, 'authority_strict', NULL, ${pendingBody}::jsonb, NULL
    )
    ON CONFLICT (workspace_id, actor_user_id, route, idempotency_key)
      WHERE mode = 'authority_strict'
    DO NOTHING
    RETURNING response_body
  `) as Array<{ response_body: Record<string, unknown> }>;
  if (inserted[0]) {
    return {
      command_id: input.command_id,
      lease_token: input.lease_token,
      state: 'delivery_acquired',
      replayed: false,
      reconcile_provider: false,
      command: {
        email,
        clerk_role: input.clerk_role,
        workspace_role: input.workspace_role,
        requested_workspace_role: input.requested_workspace_role,
        role_basis: input.role_basis,
      },
    };
  }

  const existing = (await sql/*sql*/`
    SELECT id, request_sha256, response_status, response_body,
           COALESCE((response_body->>'lease_expires_at')::timestamptz > now(), false) AS lease_active
    FROM idempotency_keys
    WHERE workspace_id = ${input.workspace_id}
      AND actor_user_id = ${input.actor_user_id}
      AND route = ${input.route}
      AND idempotency_key = ${input.key}
      AND mode = 'authority_strict'
    LIMIT 1
  `) as Array<{
    id: string;
    request_sha256: string;
    response_status: number | null;
    response_body: Record<string, unknown> | null;
    lease_active: boolean;
  }>;
  const row = existing[0];
  if (!row) throw makeError('INVITE_ATOMICITY_FAILED', 'invitation command reservation was not created', 500);
  if (row.request_sha256 !== input.request_sha256) {
    throw makeError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request', 409);
  }
  if (row.response_status != null && row.response_body) {
    return {
      command_id: String(row.response_body.command_id || input.command_id),
      lease_token: null,
      state: 'delivered',
      replayed: true,
      reconcile_provider: false,
      receipt: inviteReceiptFromBody(row.response_body, true),
    };
  }
  if (row.lease_active) {
    throw makeError('INVITE_IN_PROGRESS', 'this invitation is already being delivered; retry with the same key', 409);
  }

  const reclaimedBody = JSON.stringify({
    lease_token: input.lease_token,
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    state: 'pending_delivery',
  });
  const reclaimed = (await sql/*sql*/`
    UPDATE idempotency_keys
    SET response_body = response_body || ${reclaimedBody}::jsonb
    WHERE id = ${row.id}
      AND response_status IS NULL
      AND COALESCE((response_body->>'lease_expires_at')::timestamptz <= now(), true)
    RETURNING response_body
  `) as Array<{ response_body: Record<string, unknown> }>;
  const commandId = String(reclaimed[0]?.response_body?.command_id || '');
  if (!commandId) {
    throw makeError('INVITE_IN_PROGRESS', 'this invitation is already being delivered; retry with the same key', 409);
  }
  return {
    command_id: commandId,
    lease_token: input.lease_token,
    state: 'delivery_acquired',
    replayed: false,
    reconcile_provider: true,
    command: {
      email: String(reclaimed[0].response_body.email || email),
      clerk_role: String(reclaimed[0].response_body.clerk_role || input.clerk_role),
      workspace_role: String(reclaimed[0].response_body.workspace_role || input.workspace_role),
      requested_workspace_role: String(
        reclaimed[0].response_body.requested_workspace_role || input.requested_workspace_role,
      ),
      role_basis: String(reclaimed[0].response_body.role_basis || input.role_basis),
    },
  };
}

export async function finalizeCustomerInviteRow(
  sql: Sql,
  input: CustomerInviteFinalizeInput,
): Promise<CustomerInviteDeliveryReceipt> {
  validateInviteCommand(input);
  if (!input.invitation_id || !input.operation_event_id || !input.projection_outbox_id) {
    throw makeError(
      'VALIDATION_ERROR',
      'invitation_id, operation_event_id and projection_outbox_id are required',
      400,
    );
  }
  const email = input.email.trim().toLowerCase();
  const watermark = new Date().toISOString();
  const rows = (await sql/*sql*/`
    WITH target_command AS MATERIALIZED (
      SELECT id
      FROM idempotency_keys
      WHERE workspace_id = ${input.workspace_id}
        AND actor_user_id = ${input.actor_user_id}
        AND route = ${input.route}
        AND idempotency_key = ${input.key}
        AND request_sha256 = ${input.request_sha256}
        AND mode = 'authority_strict'
        AND response_status IS NULL
        AND response_body->>'command_id' = ${input.command_id}
        AND response_body->>'lease_token' = ${input.lease_token}
      FOR UPDATE
    ), command_envelope AS (
      SELECT nextval(pg_get_serial_sequence('audit_logs', 'id'))::bigint AS audit_id
      FROM target_command
    ), event_written AS (
      INSERT INTO operation_events (
        id, workspace_id, source_tool, agent_id, status, summary, body, visibility,
        occurred_at, authorized_by_user_id, instrument_kind, authority_source, request_id
      )
      SELECT ${input.operation_event_id}, ${input.workspace_id}, 'xlooop', ${input.actor_user_id},
             'completed', 'Workspace invitation delivered',
             'Clerk accepted the invitation command and returned a canonical invitation id.',
             'internal_workspace', ${watermark}::timestamptz, ${input.actor_user_id}, 'human', 'role',
             ${input.request_id ?? null}
      FROM target_command
      RETURNING id
    ), audit_written AS (
      INSERT INTO audit_logs (
        id, actor_user_id, action, target_type, target_id, workspace_id, reason,
        causation_id, metadata
      )
      SELECT command_envelope.audit_id, ${input.actor_user_id}, 'member_invite_delivered',
             'workspace_member', ${email}, ${input.workspace_id},
             ${'invite -> ' + input.workspace_role}, event_written.id,
             jsonb_build_object(
               'command_id', ${input.command_id}::text,
               'invitation_id', ${input.invitation_id}::text,
               'provider_status', ${input.provider_status}::text,
               'request_sha256', ${input.request_sha256}::text,
               'workspace_role', ${input.workspace_role}::text,
               'requested_workspace_role', ${input.requested_workspace_role}::text,
               'role_basis', ${input.role_basis}::text
             )
      FROM target_command
      JOIN command_envelope ON TRUE
      JOIN event_written ON TRUE
      RETURNING id::text AS audit_event_id
    ), outbox_written AS (
      INSERT INTO projection_outbox (
        id, workspace_id, event_type, aggregate_type, aggregate_id, payload, created_at
      )
      SELECT ${input.projection_outbox_id}, ${input.workspace_id}, 'workspace_member.invited',
             'workspace_invitation', ${input.command_id},
             jsonb_build_object(
               'command_id', ${input.command_id}::text,
               'invitation_id', ${input.invitation_id}::text,
               'email', ${email}::text,
               'workspace_role', ${input.workspace_role}::text,
               'operation_event_id', event_written.id,
               'audit_event_id', audit_written.audit_event_id,
               'request_sha256', ${input.request_sha256}::text
             ), ${watermark}::timestamptz
      FROM target_command
      JOIN event_written ON TRUE
      JOIN audit_written ON TRUE
      RETURNING id
    ), response_completed AS (
      UPDATE idempotency_keys AS command
      SET response_status = 201,
          response_body = jsonb_build_object(
            'command_id', ${input.command_id}::text,
            'invited', jsonb_build_object(
              'invitation_id', ${input.invitation_id}::text,
              'email', ${email}::text,
              'role', ${input.clerk_role}::text,
              'status', ${input.provider_status}::text,
              'workspace_role', ${input.workspace_role}::text,
              'requested_workspace_role', ${input.requested_workspace_role}::text,
              'role_basis', ${input.role_basis}::text
            ),
            'invite_receipt_id',
              ('member-invite:' || ${input.workspace_id}::text || ':' || ${input.command_id}::text
                || ':' || audit_written.audit_event_id),
            'operation_event_id', event_written.id,
            'audit_event_id', audit_written.audit_event_id,
            'projection_outbox_id', outbox_written.id,
            'read_model_watermark', ${watermark}::text,
            'delivery_status', 'delivered',
            'replayed', false
          ),
          completed_at = ${watermark}::timestamptz
      FROM target_command
      JOIN event_written ON TRUE
      JOIN audit_written ON TRUE
      JOIN outbox_written ON TRUE
      WHERE command.id = target_command.id
      RETURNING command.response_body
    ), authority_result AS (
      SELECT response_completed.response_body,
             xlooop_assert_authority_complete(
               (SELECT count(*) FROM target_command) = 1
               AND (SELECT count(*) FROM event_written) = 1
               AND (SELECT count(*) FROM audit_written) = 1
               AND (SELECT count(*) FROM outbox_written) = 1
               AND (SELECT count(*) FROM response_completed) = 1,
               'customer_invite_delivery'
             ) AS complete
      FROM response_completed
    )
    SELECT response_body FROM authority_result WHERE complete
  `) as Array<{ response_body: unknown }>;
  if (rows[0]?.response_body) return inviteReceiptFromBody(rows[0].response_body, false);

  const replay = (await sql/*sql*/`
    SELECT request_sha256, response_status, response_body
    FROM idempotency_keys
    WHERE workspace_id = ${input.workspace_id}
      AND actor_user_id = ${input.actor_user_id}
      AND route = ${input.route}
      AND idempotency_key = ${input.key}
      AND mode = 'authority_strict'
    LIMIT 1
  `) as Array<{ request_sha256: string; response_status: number | null; response_body: unknown }>;
  if (replay[0]?.request_sha256 !== input.request_sha256 || replay[0]?.response_status == null) {
    throw makeError('INVITE_ATOMICITY_FAILED', 'invitation delivery did not produce a durable authority result', 500);
  }
  return inviteReceiptFromBody(replay[0].response_body, true);
}

export async function recordCustomerInviteDeliveryFailureRow(
  sql: Sql,
  input: CustomerInviteFailureInput,
): Promise<void> {
  if (!input?.workspace_id || !input.actor_user_id || !input.command_id || !input.lease_token
    || !input.email?.trim() || !input.operation_event_id) return;
  assertWorkspaceScope(input.workspace_id);
  const email = input.email.trim().toLowerCase();
  const errorCode = String(input.error_code || 'INVITE_DELIVERY_FAILED').slice(0, 120);
  await sql/*sql*/`
    WITH command_released AS (
      UPDATE idempotency_keys
      SET response_body = response_body || jsonb_build_object(
            'state', 'delivery_failed',
            'lease_expires_at', now(),
            'last_error_code', ${errorCode}::text,
            'last_attempt_at', now()
          )
      WHERE workspace_id = ${input.workspace_id}
        AND actor_user_id = ${input.actor_user_id}
        AND route = ${input.route}
        AND idempotency_key = ${input.key}
        AND request_sha256 = ${input.request_sha256}
        AND mode = 'authority_strict'
        AND response_status IS NULL
        AND response_body->>'command_id' = ${input.command_id}
        AND response_body->>'lease_token' = ${input.lease_token}
      RETURNING id
    ), event_written AS (
      INSERT INTO operation_events (
        id, workspace_id, source_tool, agent_id, status, summary, body, visibility,
        occurred_at, authorized_by_user_id, instrument_kind, authority_source, request_id
      )
      SELECT ${input.operation_event_id}, ${input.workspace_id}, 'xlooop', ${input.actor_user_id},
             'failed', 'Workspace invitation delivery failed',
             'The external invitation provider did not produce a confirmed invitation.',
             'internal_workspace', now(), ${input.actor_user_id}, 'human', 'role', ${input.request_id ?? null}
      FROM command_released
      RETURNING id
    )
    INSERT INTO audit_logs (
      actor_user_id, action, target_type, target_id, workspace_id, reason, causation_id, metadata
    )
    SELECT ${input.actor_user_id}, 'member_invite_delivery_failed', 'workspace_member', ${email},
           ${input.workspace_id}, ${errorCode}, event_written.id,
           jsonb_build_object('command_id', ${input.command_id}::text, 'error_code', ${errorCode}::text)
    FROM command_released
    JOIN event_written ON TRUE
  `;
}
