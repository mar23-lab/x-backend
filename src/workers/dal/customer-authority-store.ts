// customer-authority-store.ts · customer authority/consent persistence helpers
//
// Authority: 018_customer_registration · CUSTOMER_ECOSYSTEM_ONBOARDING_AND_IP_BOUNDARY_STANDARD
// Keep this store SQL-only; route policy remains in routes/customer.ts and routes/sources.ts.

import { assertWorkspaceScope } from './DalAdapter';
import { makeError, randomNanoid } from './shared-helpers';
import type { Sql } from '../db/client';
import type {
  CustomerAuthorityConsent,
  CustomerAuthorityState,
  CustomerAuthorityWriteReceipt,
  CustomerConsentAckInput,
  CustomerInviteAuditInput,
  CustomerInviteAuditReceipt,
  OperatorAuthorityInput,
  PendingCustomerAuthorityApproval,
  PendingCustomerAuthorityListOpts,
  RevokeCustomerAuthorityInput,
  WorkspaceId,
} from './types';

export async function recordOperatorAuthorityRow(
  sql: Sql,
  input: OperatorAuthorityInput
): Promise<CustomerAuthorityConsent> {
  if (!input?.workspace_id || !input?.operator_user_id) {
    throw makeError('VALIDATION_ERROR', 'workspace_id and operator_user_id are required', 400);
  }
  assertWorkspaceScope(input.workspace_id);
  const id = `auth_${randomNanoid()}`;
  const rows = (await sql/*sql*/`
    INSERT INTO customer_authority_consents (
      id, workspace_id, access_request_id, operator_approved_at, operator_approved_by
    ) VALUES (
      ${id}, ${input.workspace_id}, ${input.access_request_id ?? null}, now(), ${input.operator_user_id}
    )
    ON CONFLICT (workspace_id) WHERE revoked_at IS NULL DO UPDATE SET
      operator_approved_at = now(),
      operator_approved_by = EXCLUDED.operator_approved_by,
      access_request_id    = COALESCE(EXCLUDED.access_request_id, customer_authority_consents.access_request_id),
      updated_at           = now()
    RETURNING id, workspace_id, access_request_id, operator_approved_at, operator_approved_by,
              allowed_modes, allowed_apps, consent_acked_at, consent_acked_by, full_name_typed,
              scopes_confirmed, consent_version, ip_address, user_agent, revoked_at, revoked_by,
              revoked_reason, metadata, created_at, updated_at
  `) as CustomerAuthorityConsent[];
  if (!rows[0]) throw makeError('INTERNAL_ERROR', 'failed to record operator authority', 500);
  return rows[0];
}

export async function recordCustomerConsentAckRow(
  sql: Sql,
  input: CustomerConsentAckInput
): Promise<CustomerAuthorityWriteReceipt> {
  if (
    !input?.workspace_id
    || !input?.user_id
    || !input?.full_name_typed?.trim()
    || !input.operation_event_id
    || !input.projection_outbox_id
  ) {
    throw makeError(
      'VALIDATION_ERROR',
      'workspace_id, user_id, full_name_typed, operation_event_id and projection_outbox_id are required',
      400,
    );
  }
  assertWorkspaceScope(input.workspace_id);
  const id = `auth_${randomNanoid()}`;
  const version = input.consent_version || 'authority_v1';
  // W1b · identity bundle (email + company) → metadata jsonb; merged on conflict so the
  // operator-approval side's metadata is preserved. No dedicated columns (no migration).
  const identityMeta = JSON.stringify({
    ...(input.email ? { email: input.email } : {}),
    ...(input.company ? { company: input.company } : {}),
  });
  const operatorUserId = input.auto_approve_operator_user_id || null;
  const rows = (await sql/*sql*/`
    WITH consent_written AS (
      INSERT INTO customer_authority_consents (
        id, workspace_id, access_request_id, operator_approved_at, operator_approved_by,
        consent_acked_at, consent_acked_by, full_name_typed, scopes_confirmed,
        consent_version, ip_address, user_agent, metadata
      ) VALUES (
        ${id}, ${input.workspace_id}, ${input.access_request_id ?? null},
        CASE WHEN ${operatorUserId}::text IS NULL THEN NULL ELSE now() END, ${operatorUserId},
        now(), ${input.user_id}, ${input.full_name_typed.trim()},
        ${JSON.stringify(input.scopes_confirmed ?? {})}::jsonb, ${version},
        ${input.ip_address ?? null}, ${input.user_agent ?? null}, ${identityMeta}::jsonb
      )
      ON CONFLICT (workspace_id) WHERE revoked_at IS NULL DO UPDATE SET
        operator_approved_at = CASE
          WHEN ${operatorUserId}::text IS NULL THEN customer_authority_consents.operator_approved_at
          ELSE COALESCE(customer_authority_consents.operator_approved_at, now())
        END,
        operator_approved_by = CASE
          WHEN ${operatorUserId}::text IS NULL THEN customer_authority_consents.operator_approved_by
          ELSE COALESCE(customer_authority_consents.operator_approved_by, EXCLUDED.operator_approved_by)
        END,
        consent_acked_at  = now(),
        consent_acked_by  = EXCLUDED.consent_acked_by,
        full_name_typed   = EXCLUDED.full_name_typed,
        scopes_confirmed  = EXCLUDED.scopes_confirmed,
        consent_version   = EXCLUDED.consent_version,
        ip_address        = EXCLUDED.ip_address,
        user_agent        = EXCLUDED.user_agent,
        metadata          = customer_authority_consents.metadata || EXCLUDED.metadata,
        access_request_id = COALESCE(EXCLUDED.access_request_id, customer_authority_consents.access_request_id),
        updated_at        = now()
      RETURNING id, workspace_id, access_request_id, operator_approved_at, operator_approved_by,
                allowed_modes, allowed_apps, consent_acked_at, consent_acked_by, full_name_typed,
                scopes_confirmed, consent_version, ip_address, user_agent, revoked_at, revoked_by,
                revoked_reason, metadata, created_at, updated_at
    ), event_written AS (
      INSERT INTO operation_events (
        id, workspace_id, project_id, source_tool, agent_id, status, summary,
        visibility, occurred_at, authorized_by_user_id, instrument_kind,
        authority_source, request_id
      )
      SELECT
        ${input.operation_event_id}, consent_written.workspace_id, NULL, 'xlooop',
        ${input.user_id}, 'completed',
        CASE WHEN consent_written.operator_approved_at IS NULL
          THEN 'Workspace authority consent recorded'
          ELSE 'Workspace authority consent recorded and approved'
        END,
        'internal_owner_only', now(), ${input.user_id}, 'human', 'role', ${input.request_id ?? null}
      FROM consent_written
      RETURNING id
    ), audit_written AS (
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, workspace_id, reason,
        causation_id, metadata
      )
      SELECT
        ${input.user_id}, 'customer_authority_consent_ack'::text, 'workspace',
        consent_written.workspace_id, consent_written.workspace_id,
        'typed-name workspace authority consent',
        event_written.id,
        jsonb_build_object(
          'consent_id', consent_written.id,
          'operation_event_id', event_written.id,
          'operator_auto_approved', consent_written.operator_approved_at IS NOT NULL,
          'request_id', ${input.request_id ?? null}::text
        )
      FROM consent_written
      JOIN event_written ON TRUE
      RETURNING id::text AS audit_event_id
    ), outbox_written AS (
      INSERT INTO projection_outbox (
        id, workspace_id, event_type, aggregate_type, aggregate_id, payload
      )
      SELECT
        ${input.projection_outbox_id}, consent_written.workspace_id,
        'customer.authority.consent.recorded', 'customer_authority', consent_written.id,
        jsonb_build_object(
          'consent_id', consent_written.id,
          'operation_event_id', event_written.id,
          'audit_event_id', audit_written.audit_event_id,
          'operator_approved', consent_written.operator_approved_at IS NOT NULL
        )
      FROM consent_written
      JOIN event_written ON TRUE
      JOIN audit_written ON TRUE
      RETURNING id
    )
    SELECT
      consent_written.*,
      event_written.id AS operation_event_id,
      audit_written.audit_event_id,
      outbox_written.id AS projection_outbox_id,
      consent_written.updated_at::text AS read_model_watermark
    FROM consent_written
    JOIN event_written ON TRUE
    JOIN audit_written ON TRUE
    JOIN outbox_written ON TRUE
  `) as Array<CustomerAuthorityConsent & {
    operation_event_id: string;
    audit_event_id: string;
    projection_outbox_id: string;
    read_model_watermark: string;
  }>;
  const row = rows[0];
  if (!row?.operation_event_id || !row.audit_event_id || !row.projection_outbox_id) {
    throw makeError(
      'CUSTOMER_AUTHORITY_LINEAGE_MISSING',
      'customer authority consent did not produce a complete authority receipt',
      409,
    );
  }
  const {
    operation_event_id,
    audit_event_id,
    projection_outbox_id,
    read_model_watermark,
    ...consent
  } = row;
  return {
    consent,
    authority_receipt_id: `customer-authority-consent:${consent.id}:${audit_event_id}`,
    operation_event_id,
    audit_event_id,
    projection_outbox_id,
    read_model_watermark,
  };
}

export async function getCustomerAuthorityStateRow(
  sql: Sql,
  workspaceId: WorkspaceId
): Promise<CustomerAuthorityState> {
  assertWorkspaceScope(workspaceId);
  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, access_request_id, operator_approved_at, operator_approved_by,
           allowed_modes, allowed_apps, consent_acked_at, consent_acked_by, full_name_typed,
           scopes_confirmed, consent_version, ip_address, user_agent, revoked_at, revoked_by,
           revoked_reason, metadata, created_at, updated_at
    FROM customer_authority_consents
    WHERE workspace_id = ${workspaceId} AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `) as CustomerAuthorityConsent[];
  const consent = rows[0] ?? null;
  const operatorApproved = !!(consent && consent.operator_approved_at);
  const consentAcked = !!(consent && consent.consent_acked_at);
  return {
    workspace_id: workspaceId,
    unlocked: operatorApproved && consentAcked,
    operator_approved: operatorApproved,
    consent_acked: consentAcked,
    allowed_modes: consent?.allowed_modes ?? [],
    allowed_apps: consent?.allowed_apps ?? [],
    consent,
  };
}

export async function recordCustomerInviteAuditRow(
  sql: Sql,
  input: CustomerInviteAuditInput,
): Promise<CustomerInviteAuditReceipt> {
  if (!input?.workspace_id || !input?.actor_user_id || !input?.email?.trim()) {
    throw makeError('VALIDATION_ERROR', 'workspace_id, actor_user_id and email are required', 400);
  }
  assertWorkspaceScope(input.workspace_id);
  const email = input.email.trim().toLowerCase();
  const role = input.role || 'client';
  const metadata = JSON.stringify({ email, role });
  const rows = (await sql/*sql*/`
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, metadata)
    VALUES (
      ${input.actor_user_id}, 'member_invite_request'::text, 'workspace_member',
      ${email}, ${input.workspace_id}, ${'invite -> ' + role}, ${metadata}::jsonb
    )
    RETURNING id::text AS audit_event_id
  `) as Array<{ audit_event_id: string }>;
  const auditEventId = rows[0]?.audit_event_id;
  if (!auditEventId) throw makeError('INVITE_AUDIT_RECEIPT_MISSING', 'invite audit receipt was not created', 500);
  return {
    audit_event_id: auditEventId,
    invite_receipt_id: `member-invite:${input.workspace_id}:${email}:${auditEventId}`,
  };
}

// Lifecycle L1 · withdraw authority/consent. Sets revoked_at on the ACTIVE row only (never
// hard-deletes — the row stays as an immutable audit record; the uq_customer_authority_active
// partial index frees the workspace for a fresh consent later). getCustomerAuthorityState already
// filters revoked_at IS NULL, so this re-locks connectors + team invites with no other change.
// 404 (NOT_FOUND) when there is no active row to revoke.
export async function revokeCustomerAuthorityRow(
  sql: Sql,
  input: RevokeCustomerAuthorityInput
): Promise<CustomerAuthorityWriteReceipt> {
  if (
    !input?.workspace_id
    || !input?.revoked_by
    || !input.operation_event_id
    || !input.projection_outbox_id
  ) {
    throw makeError(
      'VALIDATION_ERROR',
      'workspace_id, revoked_by, operation_event_id and projection_outbox_id are required',
      400,
    );
  }
  assertWorkspaceScope(input.workspace_id);
  const reason = input.revoked_reason?.trim() || null;
  const auditMeta = JSON.stringify(
    input.re_attest_name ? { full_name_typed: input.re_attest_name } : {}
  );
  // Single atomic statement (one implicit transaction): the UPDATE re-locks the active row, and the
  // audit_logs INSERT is gated `FROM upd` so it fires ONLY when a row was actually revoked — never a
  // no-op log when there is no active row. Audit is captured transactionally with the revoke (the
  // setUserStatusRow precedent), not best-effort at the route. The final SELECT returns the row (or
  // 0 rows → 404 below). audit_logs.action/target_type are TEXT (cast ::text); never hard-deletes.
  const rows = (await sql/*sql*/`
    WITH consent_updated AS (
      UPDATE customer_authority_consents SET
        revoked_at     = now(),
        revoked_by     = ${input.revoked_by},
        revoked_reason = ${reason},
        updated_at     = now()
      WHERE workspace_id = ${input.workspace_id} AND revoked_at IS NULL
      RETURNING id, workspace_id, access_request_id, operator_approved_at, operator_approved_by,
                allowed_modes, allowed_apps, consent_acked_at, consent_acked_by, full_name_typed,
                scopes_confirmed, consent_version, ip_address, user_agent, revoked_at, revoked_by,
                revoked_reason, metadata, created_at, updated_at
    ), event_written AS (
      INSERT INTO operation_events (
        id, workspace_id, project_id, source_tool, agent_id, status, summary,
        visibility, occurred_at, authorized_by_user_id, instrument_kind,
        authority_source, request_id
      )
      SELECT
        ${input.operation_event_id}, consent_updated.workspace_id, NULL, 'xlooop',
        ${input.revoked_by}, 'completed', 'Workspace authority revoked',
        'internal_owner_only', now(), ${input.revoked_by}, 'human', 'role', ${input.request_id ?? null}
      FROM consent_updated
      RETURNING id
    ), audit_written AS (
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, workspace_id, reason,
        causation_id, metadata
      )
      SELECT
        ${input.revoked_by}, 'customer_authority_revoke'::text, 'workspace',
        consent_updated.workspace_id, consent_updated.workspace_id, ${reason},
        event_written.id,
        ${auditMeta}::jsonb || jsonb_build_object(
          'consent_id', consent_updated.id,
          'operation_event_id', event_written.id,
          'request_id', ${input.request_id ?? null}::text
        )
      FROM consent_updated
      JOIN event_written ON TRUE
      RETURNING id::text AS audit_event_id
    ), outbox_written AS (
      INSERT INTO projection_outbox (
        id, workspace_id, event_type, aggregate_type, aggregate_id, payload
      )
      SELECT
        ${input.projection_outbox_id}, consent_updated.workspace_id,
        'customer.authority.revoked', 'customer_authority', consent_updated.id,
        jsonb_build_object(
          'consent_id', consent_updated.id,
          'operation_event_id', event_written.id,
          'audit_event_id', audit_written.audit_event_id
        )
      FROM consent_updated
      JOIN event_written ON TRUE
      JOIN audit_written ON TRUE
      RETURNING id
    )
    SELECT
      consent_updated.*,
      event_written.id AS operation_event_id,
      audit_written.audit_event_id,
      outbox_written.id AS projection_outbox_id,
      consent_updated.updated_at::text AS read_model_watermark
    FROM consent_updated
    JOIN event_written ON TRUE
    JOIN audit_written ON TRUE
    JOIN outbox_written ON TRUE
  `) as Array<CustomerAuthorityConsent & {
    operation_event_id: string;
    audit_event_id: string;
    projection_outbox_id: string;
    read_model_watermark: string;
  }>;
  const row = rows[0];
  if (!row) {
    throw makeError('NOT_FOUND', 'no active authority/consent to revoke for this workspace', 404);
  }
  if (!row.operation_event_id || !row.audit_event_id || !row.projection_outbox_id) {
    throw makeError(
      'CUSTOMER_AUTHORITY_LINEAGE_MISSING',
      'customer authority revocation did not produce a complete authority receipt',
      409,
    );
  }
  const {
    operation_event_id,
    audit_event_id,
    projection_outbox_id,
    read_model_watermark,
    ...consent
  } = row;
  return {
    consent,
    authority_receipt_id: `customer-authority-revoke:${consent.id}:${audit_event_id}`,
    operation_event_id,
    audit_event_id,
    projection_outbox_id,
    read_model_watermark,
  };
}

// Lifecycle L2 · the operator approval inbox. Lists workspaces where the CUSTOMER side is recorded
// (consent_acked_at IS NOT NULL) but the OPERATOR side is not yet (operator_approved_at IS NULL) and
// the row is active (revoked_at IS NULL) — i.e. exactly the rows the operator must approve to unlock.
// Cross-workspace (operator/admin scope) — NOT workspace-scoped, so no assertWorkspaceScope.
export async function listPendingCustomerAuthorityApprovalsRow(
  sql: Sql,
  opts: PendingCustomerAuthorityListOpts = {}
): Promise<PendingCustomerAuthorityApproval[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = (await sql/*sql*/`
    SELECT cac.workspace_id            AS workspace_id,
           w.name                      AS workspace_name,
           w.owner_user_id             AS owner_user_id,
           u.email                     AS owner_email,
           cac.consent_acked_by        AS consent_acked_by,
           cac.consent_acked_at        AS consent_acked_at,
           cac.full_name_typed         AS full_name_typed,
           cac.consent_version         AS consent_version
    FROM customer_authority_consents cac
    JOIN workspaces w ON w.id = cac.workspace_id
    LEFT JOIN users u ON u.id = w.owner_user_id
    WHERE cac.consent_acked_at IS NOT NULL
      AND cac.operator_approved_at IS NULL
      AND cac.revoked_at IS NULL
    ORDER BY cac.consent_acked_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `) as PendingCustomerAuthorityApproval[];
  return rows;
}
