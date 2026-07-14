// customer-readiness-store.ts · customer readiness assessment persistence helpers
//
// Authority: 018_customer_registration · x-web readiness registration payload.

import { makeError, randomNanoid } from './shared-helpers';
import type { Sql, SqlTx } from '../db/client';
import type { ReadinessAssessment, ReadinessAssessmentInput } from './types';

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
