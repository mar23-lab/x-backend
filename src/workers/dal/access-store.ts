// access-store.ts · access-request (onboarding funnel, Path B) CRUD + review group.
//
// Authority: DATABASE_SCHEMA_V1.md (access_requests, audit_logs) · API_CONTRACT_V1.md ·
// AUTH_TENANCY_MODEL.md §Entitlement model. Lifted verbatim out of WorkersDalAdapter
// (Stage 3.1, F10) to decompose the DAL god-object; behaviour is byte-for-byte identical to the
// prior inline methods.
//
// These methods are NOT workspace-scoped (access_requests is a global onboarding funnel; the
// route layer enforces the admin gate on the list/get/approve/reject methods, and
// createAccessRequest is the public request-access entrypoint). So there is NO assertWorkspaceScope
// call — identical to the inline originals. makeError + randomNanoid are imported from
// ./shared-helpers (same call shapes). The normalizeAccessRequest row-normalizer moves here with
// the methods (no other DAL method references it).
//
// approveAccessRequestRow / rejectAccessRequestRow preserve the sql.transaction([...]) shape
// EXACTLY (UPDATE access_requests + INSERT audit_logs [+ SELECT 1 sentinel in approve]) — the
// audit_logs INSERTs are part of the transaction array inline, NOT routed through appendAuditLog,
// identical to the inline originals (same pattern as user-store's setUserStatusRow). These methods
// run ONLY their own SQL — they do NOT orchestrate any other DAL method or an onboarding
// provisioner — so the extraction needs no class methods passed in.

import { makeError, randomNanoid } from './shared-helpers';
import type {
  UserId,
  WorkspaceId,
  AccessRequest,
  AccessRequestInput,
  AccessRequestListOpts,
} from './types';
import type { Sql, SqlTx } from '../db/client';

// ------------------------------------------------------------
// Internal helpers (lifted verbatim from WorkersDalAdapter)
// ------------------------------------------------------------

function normalizeAccessRequest(row: AccessRequest): AccessRequest {
  return {
    ...row,
    company_name: row.company_name ?? null,
    reason: row.reason ?? null,
    source: row.source ?? null,
    ip_address: row.ip_address ?? null,
    user_agent: row.user_agent ?? null,
    user_id: row.user_id ?? null,
    reviewed_at: row.reviewed_at ?? null,
    reviewed_by: row.reviewed_by ?? null,
    rejection_reason: row.rejection_reason ?? null,
    invited_to_workspace_id: row.invited_to_workspace_id ?? null,
    metadata: row.metadata ?? {},
  };
}

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function createAccessRequestRow(sql: Sql, input: AccessRequestInput): Promise<AccessRequest> {
  if (!input?.email || typeof input.email !== 'string') {
    throw makeError('VALIDATION_ERROR', 'email is required', 400);
  }
  const id = `req_${randomNanoid()}`;

  // Idempotent on (email, status=pending) — return existing if a pending one exists
  const existing = (await sql/*sql*/`
    SELECT id, email, company_name, reason, source, status, ip_address, user_agent,
           user_id, reviewed_at, reviewed_by, rejection_reason,
           invited_to_workspace_id, metadata, created_at, updated_at
    FROM access_requests
    WHERE email = ${input.email} AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `) as AccessRequest[];
  if (existing.length > 0) {
    // Repeat submission for the same email while still pending: a later funnel run
    // carries fields the first run lacked (e.g. company_name + the readiness report).
    // Previously we returned the stale row untouched, so the new company_name was
    // dropped (req_TzPnv... stayed company_name=null after a real re-submit). Refresh
    // the row with any newly-supplied value (new-non-null wins, else keep existing),
    // bump updated_at, and return the refreshed row. Readiness/enrichment re-attaches
    // separately on the returned access_request_id (customer-readiness-store upsert).
    const ex = existing[0]!;
    const refreshed = (await sql/*sql*/`
      UPDATE access_requests SET
        company_name = COALESCE(${input.company_name ?? null}, company_name),
        reason       = COALESCE(${input.reason ?? null}, reason),
        ip_address   = COALESCE(${input.ip_address ?? null}, ip_address),
        user_agent   = COALESCE(${input.user_agent ?? null}, user_agent),
        updated_at   = now()
      WHERE id = ${ex.id} AND status = 'pending'
      RETURNING id, email, company_name, reason, source, status, ip_address, user_agent,
                user_id, reviewed_at, reviewed_by, rejection_reason,
                invited_to_workspace_id, metadata, created_at, updated_at
    `) as AccessRequest[];
    return normalizeAccessRequest(refreshed[0] ?? ex);
  }

  const rows = (await sql/*sql*/`
    INSERT INTO access_requests (
      id, email, company_name, reason, source, ip_address, user_agent
    ) VALUES (
      ${id},
      ${input.email},
      ${input.company_name ?? null},
      ${input.reason ?? null},
      ${input.source ?? 'web'},
      ${input.ip_address ?? null},
      ${input.user_agent ?? null}
    )
    RETURNING id, email, company_name, reason, source, status, ip_address, user_agent,
              user_id, reviewed_at, reviewed_by, rejection_reason,
              invited_to_workspace_id, metadata, created_at, updated_at
  `) as AccessRequest[];
  return normalizeAccessRequest(rows[0]!);
}

export async function listAccessRequestsRow(sql: Sql, opts: AccessRequestListOpts): Promise<AccessRequest[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const statusFilter = opts.status ?? null;
  const beforeId = opts.before_id ?? null;

  const rows = (await sql/*sql*/`
    SELECT id, email, company_name, reason, source, status, ip_address, user_agent,
           user_id, reviewed_at, reviewed_by, rejection_reason,
           invited_to_workspace_id, metadata, created_at, updated_at
    FROM access_requests
    WHERE (${statusFilter}::text IS NULL OR status = ${statusFilter}::text)
      AND (${beforeId}::text IS NULL OR id < ${beforeId}::text)
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `) as AccessRequest[];
  return rows.map(normalizeAccessRequest);
}

export async function getAccessRequestRow(sql: Sql, id: string): Promise<AccessRequest | null> {
  const rows = (await sql/*sql*/`
    SELECT id, email, company_name, reason, source, status, ip_address, user_agent,
           user_id, reviewed_at, reviewed_by, rejection_reason,
           invited_to_workspace_id, metadata, created_at, updated_at
    FROM access_requests WHERE id = ${id} LIMIT 1
  `) as AccessRequest[];
  return rows[0] ? normalizeAccessRequest(rows[0]) : null;
}

export async function approveAccessRequestRow(
  sql: Sql,
  requestId: string,
  actorUserId: UserId,
  opts?: { rejection_reason?: never; invited_to_workspace_id?: WorkspaceId }
): Promise<AccessRequest> {
  const invitedWs = opts?.invited_to_workspace_id ?? null;

  // Single transaction: update access_request + upsert users + audit log
  const [reqRows, , ] = (await (sql as SqlTx).transaction([
    sql/*sql*/`
      UPDATE access_requests
      SET status = 'invited',
          reviewed_at = now(),
          reviewed_by = ${actorUserId},
          invited_to_workspace_id = COALESCE(${invitedWs}, invited_to_workspace_id),
          updated_at = now()
      WHERE id = ${requestId} AND status = 'pending'
      RETURNING id, email, company_name, reason, source, status, ip_address, user_agent,
                user_id, reviewed_at, reviewed_by, rejection_reason,
                invited_to_workspace_id, metadata, created_at, updated_at
    `,
    sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      VALUES (${actorUserId}, 'access_request_approve', 'access_request', ${requestId}, ${invitedWs}, NULL)
    `,
    sql/*sql*/`
      SELECT 1 AS ok
    `,
  ])) as [AccessRequest[], unknown, unknown];

  if (!reqRows[0]) {
    throw makeError('NOT_FOUND', `access request ${requestId} not found or not pending`, 404);
  }
  return normalizeAccessRequest(reqRows[0]);
}

export async function rejectAccessRequestRow(
  sql: Sql,
  requestId: string,
  actorUserId: UserId,
  reason: string
): Promise<AccessRequest> {
  const [reqRows] = (await (sql as SqlTx).transaction([
    sql/*sql*/`
      UPDATE access_requests
      SET status = 'rejected',
          reviewed_at = now(),
          reviewed_by = ${actorUserId},
          rejection_reason = ${reason},
          updated_at = now()
      WHERE id = ${requestId} AND status = 'pending'
      RETURNING id, email, company_name, reason, source, status, ip_address, user_agent,
                user_id, reviewed_at, reviewed_by, rejection_reason,
                invited_to_workspace_id, metadata, created_at, updated_at
    `,
    sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, reason)
      VALUES (${actorUserId}, 'access_request_reject', 'access_request', ${requestId}, ${reason})
    `,
  ])) as [AccessRequest[], unknown];

  if (!reqRows[0]) {
    throw makeError('NOT_FOUND', `access request ${requestId} not found or not pending`, 404);
  }
  return normalizeAccessRequest(reqRows[0]);
}
