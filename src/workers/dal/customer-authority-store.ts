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
  CustomerConsentAckInput,
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
): Promise<CustomerAuthorityConsent> {
  if (!input?.workspace_id || !input?.user_id || !input?.full_name_typed?.trim()) {
    throw makeError('VALIDATION_ERROR', 'workspace_id, user_id and full_name_typed are required', 400);
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
  const rows = (await sql/*sql*/`
    INSERT INTO customer_authority_consents (
      id, workspace_id, access_request_id, consent_acked_at, consent_acked_by,
      full_name_typed, scopes_confirmed, consent_version, ip_address, user_agent, metadata
    ) VALUES (
      ${id}, ${input.workspace_id}, ${input.access_request_id ?? null}, now(), ${input.user_id},
      ${input.full_name_typed.trim()}, ${JSON.stringify(input.scopes_confirmed ?? {})}::jsonb, ${version},
      ${input.ip_address ?? null}, ${input.user_agent ?? null}, ${identityMeta}::jsonb
    )
    ON CONFLICT (workspace_id) WHERE revoked_at IS NULL DO UPDATE SET
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
  `) as CustomerAuthorityConsent[];
  if (!rows[0]) throw makeError('INTERNAL_ERROR', 'failed to record customer consent', 500);
  return rows[0];
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

// Lifecycle L1 · withdraw authority/consent. Sets revoked_at on the ACTIVE row only (never
// hard-deletes — the row stays as an immutable audit record; the uq_customer_authority_active
// partial index frees the workspace for a fresh consent later). getCustomerAuthorityState already
// filters revoked_at IS NULL, so this re-locks connectors + team invites with no other change.
// 404 (NOT_FOUND) when there is no active row to revoke.
export async function revokeCustomerAuthorityRow(
  sql: Sql,
  input: RevokeCustomerAuthorityInput
): Promise<CustomerAuthorityConsent> {
  if (!input?.workspace_id || !input?.revoked_by) {
    throw makeError('VALIDATION_ERROR', 'workspace_id and revoked_by are required', 400);
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
    WITH upd AS (
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
    ), aud AS (
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, metadata)
      SELECT ${input.revoked_by}, 'customer_authority_revoke'::text, 'workspace', upd.workspace_id,
             upd.workspace_id, ${reason}, ${auditMeta}::jsonb
      FROM upd
    )
    SELECT * FROM upd
  `) as CustomerAuthorityConsent[];
  if (!rows[0]) {
    throw makeError('NOT_FOUND', 'no active authority/consent to revoke for this workspace', 404);
  }
  return rows[0];
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
