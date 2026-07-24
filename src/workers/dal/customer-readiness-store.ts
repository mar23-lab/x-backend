// customer-readiness-store.ts · customer readiness assessment persistence helpers
//
// Authority: 018_customer_registration · x-web readiness registration payload.

import { makeError, randomNanoid } from './shared-helpers';
import type { Sql, SqlTx } from '../db/client';
import type { ReadinessAssessment, ReadinessAssessmentInput } from './types';

export interface WorkspaceReadinessWriteInput extends Omit<ReadinessAssessmentInput, 'access_request_id'> {
  workspace_id: string;
  user_id: string;
  client_request_id: string;
  request_digest: string;
}

export interface WorkspaceReadinessWriteResult extends ReadinessAssessment {
  readiness_revision_id: string;
  audit_event_id: string;
  replayed: boolean;
  request_digest: string;
}

export async function createReadinessAssessmentRow(
  sql: Sql,
  input: ReadinessAssessmentInput
): Promise<ReadinessAssessment> {
  if (!input?.access_request_id || !input?.email) {
    throw makeError('VALIDATION_ERROR', 'access_request_id and email are required', 400);
  }
  const id = `rdy_${randomNanoid()}`;
  const accountType = input.account_type ?? 'company';
  const [rows] = (await (sql as SqlTx).transaction([
    sql/*sql*/`
      INSERT INTO readiness_assessments (
        id, access_request_id, email, account_type, also_personal_space,
        company_name, domain, country, deep_level,
        readiness_answers, deep_check, enrichment, consent, source
      ) VALUES (
        ${id}, ${input.access_request_id}, ${input.email}, ${accountType}, ${!!input.also_personal_space},
        ${input.company_name ?? null}, ${input.domain ?? null}, ${input.country ?? null}, ${input.deep_level ?? null},
        ${JSON.stringify(input.readiness_answers ?? {})}::jsonb,
        ${input.deep_check ? JSON.stringify(input.deep_check) : null}::jsonb,
        ${input.enrichment ? JSON.stringify(input.enrichment) : null}::jsonb,
        ${JSON.stringify(input.consent ?? {})}::jsonb,
        ${input.source ?? null}
      )
      ON CONFLICT (access_request_id) DO UPDATE SET
        account_type        = EXCLUDED.account_type,
        also_personal_space = EXCLUDED.also_personal_space,
        company_name        = COALESCE(EXCLUDED.company_name, readiness_assessments.company_name),
        domain              = COALESCE(EXCLUDED.domain, readiness_assessments.domain),
        country             = COALESCE(EXCLUDED.country, readiness_assessments.country),
        deep_level          = COALESCE(EXCLUDED.deep_level, readiness_assessments.deep_level),
        readiness_answers   = EXCLUDED.readiness_answers,
        deep_check          = COALESCE(EXCLUDED.deep_check, readiness_assessments.deep_check),
        enrichment          = COALESCE(EXCLUDED.enrichment, readiness_assessments.enrichment),
        consent             = EXCLUDED.consent,
        updated_at          = now()
      RETURNING id, access_request_id, user_id, workspace_id, email, account_type,
                also_personal_space, company_name, domain, country, deep_level,
                readiness_answers, deep_check, enrichment, consent, source, metadata,
                created_at, updated_at
    `,
    sql/*sql*/`
      UPDATE access_requests
      SET account_type = ${accountType},
          readiness_assessment_id = (
            SELECT id FROM readiness_assessments WHERE access_request_id = ${input.access_request_id}
          ),
          updated_at = now()
      WHERE id = ${input.access_request_id}
    `,
  ])) as [ReadinessAssessment[], unknown];
  if (!rows[0]) throw makeError('INTERNAL_ERROR', 'failed to persist readiness assessment', 500);
  return rows[0];
}

/**
 * Persist an authenticated customer's onboarding baseline and its audit receipt atomically.
 *
 * The table still requires an access_request_id, so an already-provisioned workspace without a
 * historical request receives one approved, workspace-bound provenance row. The readiness profile
 * remains the single source of truth. A transaction advisory lock plus the audit metadata makes a
 * client_request_id replay-safe without requiring a schema migration.
 */
export async function saveWorkspaceReadinessAssessmentRow(
  sql: Sql,
  input: WorkspaceReadinessWriteInput,
): Promise<WorkspaceReadinessWriteResult> {
  if (!input?.workspace_id || !input.user_id || !input.email) {
    throw makeError('VALIDATION_ERROR', 'workspace_id, user_id and email are required', 400);
  }
  if (!input.client_request_id || input.client_request_id.length > 200) {
    throw makeError('VALIDATION_ERROR', 'a client_request_id of at most 200 characters is required', 400);
  }
  if (!/^[a-f0-9]{64}$/.test(input.request_digest)) {
    throw makeError('VALIDATION_ERROR', 'request_digest must be a lower-case SHA-256 value', 400);
  }

  const accessRequestId = `req_${randomNanoid()}`;
  const readinessId = `rdy_${randomNanoid()}`;
  const accountType = input.account_type ?? 'company';
  const lockKey = `${input.workspace_id}:${input.client_request_id}`;

  const rows = (await sql/*sql*/`
    WITH lock_held AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS held
    ), prior_receipt AS MATERIALIZED (
      SELECT
        a.id::text AS audit_event_id,
        a.metadata->>'readiness_assessment_id' AS readiness_assessment_id,
        a.metadata->>'request_digest' AS request_digest
      FROM lock_held
      JOIN audit_logs a
        ON a.workspace_id = ${input.workspace_id}
       AND a.actor_user_id = ${input.user_id}
       AND a.action = 'readiness_update'
       AND a.metadata->>'client_request_id' = ${input.client_request_id}
      ORDER BY a.id DESC
      LIMIT 1
    ), existing_readiness AS MATERIALIZED (
      SELECT r.id, r.access_request_id
      FROM lock_held
      JOIN LATERAL (
        SELECT id, access_request_id
        FROM readiness_assessments
        WHERE workspace_id = ${input.workspace_id}
        ORDER BY updated_at DESC
        LIMIT 1
      ) r ON TRUE
      WHERE NOT EXISTS (SELECT 1 FROM prior_receipt)
    ), existing_request AS MATERIALIZED (
      SELECT r.id
      FROM lock_held
      JOIN LATERAL (
        SELECT ar.id
        FROM access_requests ar
        WHERE (
          ar.id = (SELECT access_request_id FROM existing_readiness)
          OR (
            NOT EXISTS (SELECT 1 FROM existing_readiness)
            AND ar.invited_to_workspace_id = ${input.workspace_id}
            AND lower(ar.email) = lower(${input.email})
            AND ar.status IN ('approved', 'invited')
          )
        )
        ORDER BY
          (ar.id = (SELECT access_request_id FROM existing_readiness)) DESC,
          ar.updated_at DESC
        LIMIT 1
      ) r ON TRUE
      WHERE NOT EXISTS (SELECT 1 FROM prior_receipt)
    ), request_created AS (
      INSERT INTO access_requests (
        id, email, company_name, reason, source, status, user_id,
        reviewed_at, reviewed_by, invited_to_workspace_id, metadata
      )
      SELECT
        ${accessRequestId}, ${input.email}, ${input.company_name ?? null},
        'Authenticated workspace onboarding baseline persistence',
        'inapp-readiness-profile', 'approved', ${input.user_id},
        now(), ${input.user_id}, ${input.workspace_id},
        jsonb_build_object('purpose', 'workspace_readiness_profile')
      FROM lock_held
      WHERE NOT EXISTS (SELECT 1 FROM prior_receipt)
        AND NOT EXISTS (SELECT 1 FROM existing_request)
      RETURNING id
    ), request_target AS MATERIALIZED (
      SELECT access_request_id AS id FROM existing_readiness
      UNION ALL
      SELECT id FROM existing_request
        WHERE NOT EXISTS (SELECT 1 FROM existing_readiness)
      UNION ALL
      SELECT id FROM request_created
        WHERE NOT EXISTS (SELECT 1 FROM existing_readiness)
          AND NOT EXISTS (SELECT 1 FROM existing_request)
      LIMIT 1
    ), readiness_written AS (
      INSERT INTO readiness_assessments (
        id, access_request_id, user_id, workspace_id, email, account_type,
        also_personal_space, company_name, domain, country, deep_level,
        readiness_answers, deep_check, enrichment, consent, source
      )
      SELECT
        ${readinessId}, request_target.id, ${input.user_id}, ${input.workspace_id},
        ${input.email}, ${accountType}, ${!!input.also_personal_space},
        ${input.company_name ?? null}, ${input.domain ?? null}, ${input.country ?? null},
        ${input.deep_level ?? null}, ${JSON.stringify(input.readiness_answers ?? {})}::jsonb,
        ${input.deep_check ? JSON.stringify(input.deep_check) : null}::jsonb,
        ${input.enrichment ? JSON.stringify(input.enrichment) : null}::jsonb,
        ${JSON.stringify(input.consent ?? {})}::jsonb, ${input.source ?? 'inapp-readiness-profile'}
      FROM request_target
      ON CONFLICT (access_request_id) DO UPDATE SET
        user_id             = COALESCE(readiness_assessments.user_id, EXCLUDED.user_id),
        workspace_id        = EXCLUDED.workspace_id,
        email               = EXCLUDED.email,
        account_type        = EXCLUDED.account_type,
        also_personal_space = EXCLUDED.also_personal_space,
        company_name        = EXCLUDED.company_name,
        domain              = EXCLUDED.domain,
        country             = EXCLUDED.country,
        deep_level          = EXCLUDED.deep_level,
        readiness_answers   = EXCLUDED.readiness_answers,
        deep_check          = EXCLUDED.deep_check,
        enrichment          = EXCLUDED.enrichment,
        consent             = EXCLUDED.consent,
        source              = EXCLUDED.source,
        updated_at          = now()
      RETURNING id, access_request_id, user_id, workspace_id, email, account_type,
                also_personal_space, company_name, domain, country, deep_level,
                readiness_answers, deep_check, enrichment, consent, source, metadata,
                created_at, updated_at
    ), request_linked AS (
      UPDATE access_requests a
      SET user_id = COALESCE(a.user_id, ${input.user_id}),
          invited_to_workspace_id = COALESCE(a.invited_to_workspace_id, ${input.workspace_id}),
          updated_at = now()
      FROM readiness_written r
      WHERE a.id = r.access_request_id
      RETURNING a.id
    ), audit_written AS (
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, workspace_id, reason, metadata
      )
      SELECT
        ${input.user_id}, 'readiness_update', 'workspace', ${input.workspace_id},
        ${input.workspace_id}, 'Authenticated customer saved onboarding baseline',
        jsonb_build_object(
          'schema_id', 'xlooop.readiness_write_receipt.v1',
          'client_request_id', ${input.client_request_id},
          'request_digest', ${input.request_digest},
          'readiness_assessment_id', r.id
        )
      FROM readiness_written r
      JOIN request_linked q ON q.id = r.access_request_id
      RETURNING id::text AS audit_event_id
    ), written_receipt AS (
      SELECT
        r.*,
        'readiness:' || r.id || ':' || a.audit_event_id AS readiness_revision_id,
        a.audit_event_id,
        false AS replayed,
        ${input.request_digest}::text AS request_digest
      FROM readiness_written r
      JOIN audit_written a ON TRUE
    ), replayed_receipt AS (
      SELECT
        r.*,
        'readiness:' || r.id || ':' || p.audit_event_id AS readiness_revision_id,
        p.audit_event_id,
        true AS replayed,
        p.request_digest
      FROM prior_receipt p
      JOIN readiness_assessments r
        ON r.id = p.readiness_assessment_id
       AND r.workspace_id = ${input.workspace_id}
    )
    SELECT * FROM written_receipt
    UNION ALL
    SELECT * FROM replayed_receipt
    LIMIT 1
  `) as WorkspaceReadinessWriteResult[];

  const row = rows[0];
  if (!row?.readiness_revision_id || !row.audit_event_id || !row.id || !row.workspace_id) {
    throw makeError('INTERNAL_ERROR', 'readiness write did not produce an audit receipt', 500);
  }
  if (row.replayed && row.request_digest !== input.request_digest) {
    throw makeError('CONFLICT', 'client_request_id was already used for different onboarding answers', 409);
  }
  return row;
}

export async function getReadinessAssessmentRow(
  sql: Sql,
  accessRequestId: string
): Promise<ReadinessAssessment | null> {
  if (!accessRequestId) return null;
  const rows = (await sql/*sql*/`
    SELECT id, access_request_id, user_id, workspace_id, email, account_type,
           also_personal_space, company_name, domain, country, deep_level,
           readiness_answers, deep_check, enrichment, consent, source, metadata,
           created_at, updated_at
    FROM readiness_assessments WHERE access_request_id = ${accessRequestId} LIMIT 1
  `) as ReadinessAssessment[];
  return rows[0] ?? null;
}

// S1 (260628) · read the readiness assessment by WORKSPACE id (the column is stamped during
// provisioning — customer-provisioning-store.ts). This is the seam that lets the cockpit chat +
// the MCP get_effective_profile (which only have workspace_id) recover the captured company
// context, instead of the context being a write-only silo. Newest-first if more than one.
export async function getReadinessAssessmentByWorkspaceRow(
  sql: Sql,
  workspaceId: string
): Promise<ReadinessAssessment | null> {
  if (!workspaceId) return null;
  const rows = (await sql/*sql*/`
    SELECT id, access_request_id, user_id, workspace_id, email, account_type,
           also_personal_space, company_name, domain, country, deep_level,
           readiness_answers, deep_check, enrichment, consent, source, metadata,
           created_at, updated_at
    FROM readiness_assessments WHERE workspace_id = ${workspaceId}
    ORDER BY updated_at DESC LIMIT 1
  `) as ReadinessAssessment[];
  return rows[0] ?? null;
}

// Part R · Stage C (260628) · read the newest readiness by EMAIL — the seam that links an ANONYMOUS
// website-funnel lead's captured context to their workspace when they later register. SAFE ONLY at a
// post-Clerk-JWT-verify caller (the email is verified there); NEVER call from a pre-auth route.
export async function getReadinessAssessmentByEmailRow(
  sql: Sql,
  email: string
): Promise<ReadinessAssessment | null> {
  if (!email) return null;
  const rows = (await sql/*sql*/`
    SELECT id, access_request_id, user_id, workspace_id, email, account_type,
           also_personal_space, company_name, domain, country, deep_level,
           readiness_answers, deep_check, enrichment, consent, source, metadata,
           created_at, updated_at
    FROM readiness_assessments WHERE lower(email) = lower(${email})
    ORDER BY updated_at DESC LIMIT 1
  `) as ReadinessAssessment[];
  return rows[0] ?? null;
}

// Part R · Stage C (260628) · stamp a verified-email lead's captured readiness onto their NEW
// workspace so getReadinessAssessmentByWorkspaceRow recovers it. Only touches NULL-workspace rows
// (never re-points an already-attached assessment). Returns the count stamped. Caller MUST pass a
// Clerk-verified email.
export async function attachReadinessToWorkspaceByEmailRow(
  sql: Sql,
  email: string,
  workspaceId: string,
  userId: string | null
): Promise<number> {
  if (!email || !workspaceId) return 0;
  const rows = (await sql/*sql*/`
    UPDATE readiness_assessments
    SET workspace_id = ${workspaceId}, user_id = COALESCE(user_id, ${userId}), updated_at = now()
    WHERE lower(email) = lower(${email}) AND workspace_id IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length;
}
