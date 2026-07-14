// customer-token-store.ts · customer API token CRUD (read-only/operational connector credential).
//
// Generalizes the canary service-token pattern (middleware/auth.ts canaryAuth, which matches a
// SHA-256 hash from env) into a revocable, workspace-scoped, per-customer credential persisted in
// customer_api_tokens (migration 037). We store ONLY the SHA-256 of the token; the raw value is
// returned once at mint and never again.
//
// Authority: docs/customer-onboarding/CLAUDE_CODE_API_ONBOARDING.md (steps 6/9/10).
// Pattern: lifted from access-store.ts — store functions take `sql` + params, return typed rows,
// use makeError + randomNanoid from ./shared-helpers. NOT a god-object method; route + auth layers
// enforce the gates.

import { makeError, randomNanoid } from './shared-helpers';
import type { Sql } from '../db/client';
import type { WorkspaceId, WorkspaceRole } from './types';

export type CustomerTokenRole = Extract<WorkspaceRole, 'viewer' | 'operator'>;

export interface CustomerApiToken {
  id: string;
  workspace_id: WorkspaceId;
  role: CustomerTokenRole;
  label: string;
  packet_prefix: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  last_used_at: string | null;
}

export interface CreateCustomerTokenInput {
  workspace_id: WorkspaceId;
  token_sha256: string;       // lower-case 64 hex; caller hashes the raw token
  role: CustomerTokenRole;
  label: string;
  packet_prefix: string;
  created_by: string;
  expires_at: string;         // ISO timestamp
}

/** SHA-256 → lower-case hex. Identical algorithm to middleware/auth.ts sha256Hex so hashes match. */
export async function hashToken(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function normalize(row: CustomerApiToken): CustomerApiToken {
  return {
    ...row,
    revoked_at: row.revoked_at ?? null,
    revoked_by: row.revoked_by ?? null,
    last_used_at: row.last_used_at ?? null,
  };
}

export async function createCustomerTokenRow(
  sql: Sql,
  input: CreateCustomerTokenInput,
): Promise<CustomerApiToken> {
  if (!/^[a-f0-9]{64}$/.test(input.token_sha256)) {
    throw makeError('VALIDATION_ERROR', 'token_sha256 must be 64 lower-case hex chars', 400);
  }
  if (input.role !== 'viewer' && input.role !== 'operator') {
    throw makeError('VALIDATION_ERROR', 'role must be viewer or operator', 400);
  }
  const id = `cat_${randomNanoid()}`;
  const rows = (await sql/*sql*/`
    INSERT INTO customer_api_tokens (
      id, workspace_id, token_sha256, role, label, packet_prefix, created_by, expires_at
    ) VALUES (
      ${id},
      ${input.workspace_id},
      ${input.token_sha256},
      ${input.role},
      ${input.label},
      ${input.packet_prefix},
      ${input.created_by},
      ${input.expires_at}
    )
    RETURNING id, workspace_id, role, label, packet_prefix, created_by,
              created_at, expires_at, revoked_at, revoked_by, last_used_at
  `) as CustomerApiToken[];
  return normalize(rows[0]!);
}

/** Hot auth path: live (non-revoked) token by hash. Caller checks expiry to distinguish expired. */
export async function getCustomerTokenByHashRow(
  sql: Sql,
  tokenSha256: string,
): Promise<CustomerApiToken | null> {
  if (!/^[a-f0-9]{64}$/.test(tokenSha256)) return null;
  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, role, label, packet_prefix, created_by,
           created_at, expires_at, revoked_at, revoked_by, last_used_at
    FROM customer_api_tokens
    WHERE token_sha256 = ${tokenSha256} AND revoked_at IS NULL
    LIMIT 1
  `) as CustomerApiToken[];
  return rows[0] ? normalize(rows[0]) : null;
}

/** Fire-and-forget heartbeat; never throws into the request path. */
export async function touchCustomerTokenRow(sql: Sql, id: string): Promise<void> {
  await sql/*sql*/`UPDATE customer_api_tokens SET last_used_at = now() WHERE id = ${id}`;
}

/** Workspace-scoped revoke — you can only revoke your own workspace's token. */
export async function revokeCustomerTokenRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  id: string,
  revokedBy: string,
): Promise<CustomerApiToken> {
  const rows = (await sql/*sql*/`
    UPDATE customer_api_tokens
    SET revoked_at = now(), revoked_by = ${revokedBy}
    WHERE id = ${id} AND workspace_id = ${workspaceId} AND revoked_at IS NULL
    RETURNING id, workspace_id, role, label, packet_prefix, created_by,
              created_at, expires_at, revoked_at, revoked_by, last_used_at
  `) as CustomerApiToken[];
  if (!rows[0]) {
    throw makeError('NOT_FOUND', `token ${id} not found, not yours, or already revoked`, 404);
  }
  return normalize(rows[0]);
}

/** Workspace-scoped list (no hashes ever leave the store). */
export async function listCustomerTokensRow(
  sql: Sql,
  workspaceId: WorkspaceId,
): Promise<CustomerApiToken[]> {
  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, role, label, packet_prefix, created_by,
           created_at, expires_at, revoked_at, revoked_by, last_used_at
    FROM customer_api_tokens
    WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC
    LIMIT 100
  `) as CustomerApiToken[];
  return rows.map(normalize);
}
