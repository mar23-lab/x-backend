// source-store.ts · user_source_connections CRUD group (R50.3b).
//
// Authority: src/workers/db/migrations/008_user_source_connections.sql ·
// DalAdapter.ts R50.3b contract block · API_CONTRACT_V1.md. Lifted verbatim out of
// WorkersDalAdapter (Stage 3.1, F10) to decompose the DAL god-object; behaviour is
// byte-for-byte identical to the prior inline methods.
//
// These methods are USER-SCOPED (NOT workspace-scoped) per the R50.3b contract:
// Clerk OAuth connections belong to the user account, not the workspace, so there
// is NO assertWorkspaceScope call — identical to the inline originals. randomNanoid
// is imported from ./shared-helpers (same call shape) for the upsert id. The
// rowToUserSourceConnection row-mapper moves here alongside the methods (no other DAL
// method references it). Source writes now return joined audit receipts so commercial
// UI success cannot race ahead of persisted authority. The *ProjectSourceBinding*
// methods are a DIFFERENT group and live in ./project-store — they are NOT touched here.
//
// upsertUserSourceRow preserves the `sql`DEFAULT`` tagged-template interpolation EXACTLY
// (so omitted contract falls back to the migration-008 DB default) and the
// ON CONFLICT (user_id, provider) DO UPDATE shape verbatim.

import { makeError, randomNanoid } from './shared-helpers';
import type {
  UserId,
  WorkspaceId,
  UserSourceConnection,
  UserSourceConnectionInput,
  SourceReadPolicy,
} from './types';
import type { Sql } from '../db/client';

// G2 (migration 067) · the access-tier vocabulary. Reuses the exact 016 enum so source-tier.ts maps
// unchanged. Kept degrade-safe: reads default to 'metadata_only' if the column is absent (pre-067).
const VALID_READ_POLICIES: ReadonlySet<SourceReadPolicy> = new Set(['metadata_only', 'proposal_only', 'read_only']);

export interface SourceConnectionWriteReceipt {
  source: UserSourceConnection;
  source_binding_id: string;
  source_connection_receipt_id: string;
  audit_event_id: string;
}

export interface SourceDisconnectWriteReceipt {
  disconnected: { id: string; provider: string };
  source_disconnect_receipt_id: string;
  audit_event_id: string;
}

export interface SourceSyncWriteReceipt {
  source_sync_receipt_id: string;
  audit_event_id: string;
}

export interface SourceReadPolicyWriteReceipt {
  source: UserSourceConnection;
  read_policy_revision_id: string;
  audit_event_id: string;
}

/** True for a Postgres "column does not exist" (42703) error — lets reads degrade before 067 applies. */
function isUndefinedColumn(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = (err as { message?: string } | null)?.message || '';
  return code === '42703' || /read_policy/.test(msg) && /column/i.test(msg);
}

// ------------------------------------------------------------
// Internal helpers (lifted verbatim from WorkersDalAdapter)
// ------------------------------------------------------------

/**
 * R50.3b · row mapper for user_source_connections. Handles Postgres
 * timestamp serialization (psql returns Date objects in some driver
 * configurations; we normalize to ISO8601 strings for stable JSON).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToUserSourceConnection(row: any): UserSourceConnection {
  const toIso = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return {
    id: row.id,
    workspace_id: row.workspace_id ?? null,
    user_id: row.user_id,
    provider: row.provider,
    provider_user_id: row.provider_user_id ?? null,
    provider_username: row.provider_username ?? null,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    contract: row.contract ?? {
      version: 1,
      ingestion_mode: 'reflection_only',
      allowed_fields: ['title', 'subject', 'timestamp', 'author_login'],
      max_body_bytes: 200,
      rate_limit: { per_hour: 5000 },
    },
    status: row.status,
    // G2 · absent (pre-067 schema, or a legacy SELECT that didn't request it) ⇒ the safest tier.
    read_policy: VALID_READ_POLICIES.has(row.read_policy as SourceReadPolicy) ? (row.read_policy as SourceReadPolicy) : 'metadata_only',
    connected_at: toIso(row.connected_at) ?? '',
    last_sync_at: toIso(row.last_sync_at),
    last_sync_error: row.last_sync_error ?? null,
    created_at: toIso(row.created_at) ?? '',
    updated_at: toIso(row.updated_at) ?? '',
  };
}

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function listUserSourcesRow(sql: Sql, userId: UserId): Promise<UserSourceConnection[]> {
  if (!userId) throw new Error('listUserSources: userId required');
  // Wave λ-tail (postmortem cons #2): explicit cast — sql template returns
  // a union type (any[][] | Record<string, any>[] | FullQueryResults), TS
  // can't narrow which member at the call site. Same canonical pattern as
  // normalizeProjectRow / normalizeBoardCardRow elsewhere in this file.
  try {
    const rows = (await sql`
      SELECT id, workspace_id, user_id, provider, provider_user_id, provider_username,
             scopes, contract, status, read_policy, connected_at, last_sync_at, last_sync_error,
             created_at, updated_at
      FROM user_source_connections
      WHERE user_id = ${userId} AND disconnected_at IS NULL
      ORDER BY connected_at ASC
    `) as Record<string, unknown>[];
    return rows.map(rowToUserSourceConnection);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    // Degrade path (067 not yet applied): the same read minus read_policy — the mapper defaults it.
    const rows = (await sql`
      SELECT id, workspace_id, user_id, provider, provider_user_id, provider_username,
             scopes, contract, status, connected_at, last_sync_at, last_sync_error,
             created_at, updated_at
      FROM user_source_connections
      WHERE user_id = ${userId} AND disconnected_at IS NULL
      ORDER BY connected_at ASC
    `) as Record<string, unknown>[];
    return rows.map(rowToUserSourceConnection);
  }
}

/** D-16 (260710) · per-source read_policy across ALL of a workspace's project-source bindings, for the
 *  grounding-tier consumer. Tenant-safe via the explicit workspace filter (workspaceId is JWT-derived).
 *  Returns one row per binding; the caller folds to an effective tier per connection (effectiveTier). */
export async function listWorkspaceSourceReadPoliciesRow(
  sql: Sql,
  workspaceId: string,
): Promise<Array<{ user_source_connection_id: string | null; read_policy: string }>> {
  if (!workspaceId) return [];
  try {
    const rows = (await sql/*sql*/`
      SELECT user_source_connection_id, read_policy
      FROM project_source_bindings
      WHERE workspace_id = ${workspaceId} AND user_source_connection_id IS NOT NULL
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      user_source_connection_id: r.user_source_connection_id == null ? null : String(r.user_source_connection_id),
      read_policy: String(r.read_policy || 'metadata_only'),
    }));
  } catch { return []; }
}

/** T4/P7 (260710) · WORKSPACE-scoped source list — the MCP read tool's tenant view (a customer-token
 *  principal has no user-owned sources; the workspace's bound connections are the meaningful set). */
export async function listWorkspaceSourcesRow(sql: Sql, workspaceId: string): Promise<UserSourceConnection[]> {
  if (!workspaceId) throw new Error('listWorkspaceSources: workspaceId required');
  try {
    const rows = (await sql`
      SELECT id, workspace_id, user_id, provider, provider_user_id, provider_username,
             scopes, contract, status, read_policy, connected_at, last_sync_at, last_sync_error,
             created_at, updated_at
      FROM user_source_connections
      WHERE workspace_id = ${workspaceId} AND disconnected_at IS NULL
      ORDER BY connected_at ASC
    `) as Record<string, unknown>[];
    return rows.map(rowToUserSourceConnection);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    const rows = (await sql`
      SELECT id, workspace_id, user_id, provider, provider_user_id, provider_username,
             scopes, contract, status, connected_at, last_sync_at, last_sync_error,
             created_at, updated_at
      FROM user_source_connections
      WHERE workspace_id = ${workspaceId} AND disconnected_at IS NULL
      ORDER BY connected_at ASC
    `) as Record<string, unknown>[];
    return rows.map(rowToUserSourceConnection);
  }
}

export async function getUserSourceRow(
  sql: Sql,
  userId: UserId,
  id: string,
): Promise<UserSourceConnection | null> {
  if (!userId) throw new Error('getUserSource: userId required');
  if (!id) return null;
  try {
    const rows = (await sql`
      SELECT id, workspace_id, user_id, provider, provider_user_id, provider_username,
             scopes, contract, status, read_policy, connected_at, last_sync_at, last_sync_error,
             created_at, updated_at
      FROM user_source_connections
      WHERE id = ${id} AND user_id = ${userId}
      LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? rowToUserSourceConnection(rows[0]) : null;
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    const rows = (await sql`
      SELECT id, workspace_id, user_id, provider, provider_user_id, provider_username,
             scopes, contract, status, connected_at, last_sync_at, last_sync_error,
             created_at, updated_at
      FROM user_source_connections
      WHERE id = ${id} AND user_id = ${userId}
      LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? rowToUserSourceConnection(rows[0]) : null;
  }
}

export async function upsertUserSourceRow(
  sql: Sql,
  input: UserSourceConnectionInput,
): Promise<SourceConnectionWriteReceipt> {
  if (!input.user_id) throw new Error('upsertUserSource: user_id required');
  if (!input.provider) throw new Error('upsertUserSource: provider required');
  const id = `usc_${randomNanoid()}`;
  const status = input.status ?? 'connected';
  const scopes = input.scopes ?? [];
  // Use the migration-008 default contract when caller doesn't override.
  // The DB's DEFAULT covers omitted contract field; we explicitly pass null
  // when caller didn't provide one so Postgres applies the default.
  const contractJson = input.contract ? JSON.stringify(input.contract) : null;

  const rows = (await sql`
    WITH source_written AS (
      INSERT INTO user_source_connections (
        id, workspace_id, user_id, provider, provider_user_id, provider_username,
        scopes, contract, status, connected_at, created_at, updated_at
      ) VALUES (
        ${id}, ${input.workspace_id}, ${input.user_id}, ${input.provider},
        ${input.provider_user_id}, ${input.provider_username},
        ${scopes}::text[],
        ${contractJson === null ? sql`DEFAULT` : sql`${contractJson}::jsonb`},
        ${status}, now(), now(), now()
      )
      ON CONFLICT (user_id, provider) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        provider_user_id = EXCLUDED.provider_user_id,
        provider_username = EXCLUDED.provider_username,
        scopes = EXCLUDED.scopes,
        status = EXCLUDED.status,
        disconnected_at = NULL,  -- 044 · reconnecting a soft-disconnected source reactivates it
        updated_at = now()
      RETURNING id, workspace_id, user_id, provider, provider_user_id, provider_username,
                scopes, contract, status, connected_at, last_sync_at, last_sync_error,
                created_at, updated_at
    ),
    audit_written AS (
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, metadata)
      SELECT source_written.user_id,
             'source_connect'::text,
             CASE WHEN source_written.workspace_id IS NULL THEN 'user' ELSE 'workspace' END,
             COALESCE(source_written.workspace_id, source_written.user_id),
             source_written.workspace_id,
             ${'source connect ' + input.provider},
             jsonb_build_object('source_id', source_written.id, 'provider', source_written.provider)
      FROM source_written
      RETURNING id::text AS audit_event_id
    )
    SELECT source_written.id, source_written.workspace_id, source_written.user_id, source_written.provider,
           source_written.provider_user_id, source_written.provider_username, source_written.scopes,
           source_written.contract, source_written.status,
           source_written.connected_at, source_written.last_sync_at, source_written.last_sync_error,
           source_written.created_at, source_written.updated_at, audit_written.audit_event_id
    FROM source_written
    JOIN audit_written ON TRUE
  `) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) {
    throw new Error(`upsertUserSource: RETURNING produced no row for ${input.user_id}/${input.provider}`);
  }
  const auditEventId = typeof row.audit_event_id === 'string' ? row.audit_event_id : '';
  if (!auditEventId) throw new Error('source connect missing audit receipt');
  const source = rowToUserSourceConnection(row);
  return {
    source,
    source_binding_id: source.id,
    source_connection_receipt_id: `source-connect:${source.id}:${auditEventId}`,
    audit_event_id: auditEventId,
  };
}

export async function disconnectUserSourceRow(sql: Sql, userId: UserId, id: string, workspaceId?: WorkspaceId | null): Promise<SourceDisconnectWriteReceipt> {
  if (!userId) throw new Error('disconnectUserSource: userId required');
  if (!id) throw new Error('disconnectUserSource: id required');
  // 044 · SOFT delete (overturns R50.3b per operator 260706): preserve the row + its sync-error
  // history so disconnect is recoverable, consistent with the customer-recoverability doctrine.
  // Reads filter `disconnected_at IS NULL`, so a disconnected source leaves the active list but its
  // history survives; reconnect (via upsert ON CONFLICT, or reconnectUserSourceRow) clears the marker.
  const rows = (await sql`
    WITH source_disconnected AS (
      UPDATE user_source_connections
      SET status = 'disconnected', disconnected_at = now(), updated_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND disconnected_at IS NULL
      RETURNING id, workspace_id, user_id, provider
    ),
    audit_written AS (
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, metadata)
      SELECT ${userId},
             'source_disconnect'::text,
             CASE WHEN COALESCE(source_disconnected.workspace_id, ${workspaceId}) IS NULL THEN 'user' ELSE 'workspace' END,
             COALESCE(source_disconnected.workspace_id, ${workspaceId}, source_disconnected.user_id),
             COALESCE(source_disconnected.workspace_id, ${workspaceId}),
             'source disconnect',
             jsonb_build_object('source_id', source_disconnected.id, 'provider', source_disconnected.provider)
      FROM source_disconnected
      RETURNING id::text AS audit_event_id
    )
    SELECT source_disconnected.id, source_disconnected.provider, audit_written.audit_event_id
    FROM source_disconnected
    JOIN audit_written ON TRUE
  `) as Array<{ id: string; provider: string; audit_event_id: string }>;
  const row = rows[0];
  if (!row) throw makeError('NOT_FOUND', `source ${id} not found`, 404);
  if (!row.audit_event_id) throw new Error('source disconnect missing audit receipt');
  return {
    disconnected: { id: row.id, provider: row.provider },
    source_disconnect_receipt_id: `source-disconnect:${row.id}:${row.audit_event_id}`,
    audit_event_id: row.audit_event_id,
  };
}

function sourceSyncReceipt(id: string, result: { success: true } | { success: false; error: string }, auditEventId: string): string {
  return `source-sync:${id}:${result.success ? 'success' : 'failure'}:${auditEventId}`;
}

export async function markUserSourceSyncRow(
  sql: Sql,
  userId: UserId,
  id: string,
  result: { success: true } | { success: false; error: string },
  workspaceId?: WorkspaceId | null,
): Promise<SourceSyncWriteReceipt> {
  if (!userId) throw new Error('markUserSourceSync: userId required');
  if (!id) throw new Error('markUserSourceSync: id required');
  const action = result.success ? 'source_sync_success' : 'source_sync_failure';
  const reason = result.success ? 'source sync success' : `source sync failed: ${result.error}`.slice(0, 500);
  const rows = (await sql`
    WITH source_updated AS (
      UPDATE user_source_connections
      SET last_sync_at = CASE WHEN ${result.success}::boolean THEN now() ELSE last_sync_at END,
          last_sync_error = CASE WHEN ${result.success}::boolean THEN NULL ELSE ${result.success ? null : result.error} END,
          status = CASE WHEN ${result.success}::boolean THEN 'connected' ELSE 'error' END,
          updated_at = now()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id, workspace_id, user_id, provider, last_sync_at, last_sync_error, status
    ),
    audit_written AS (
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, metadata)
      SELECT ${userId},
             ${action}::text,
             CASE WHEN COALESCE(source_updated.workspace_id, ${workspaceId}) IS NULL THEN 'user' ELSE 'workspace' END,
             COALESCE(source_updated.workspace_id, ${workspaceId}, source_updated.user_id),
             COALESCE(source_updated.workspace_id, ${workspaceId}),
             ${reason},
             jsonb_build_object('source_id', source_updated.id, 'provider', source_updated.provider, 'status', source_updated.status, 'last_sync_error', source_updated.last_sync_error)
      FROM source_updated
      RETURNING id::text AS audit_event_id
    )
    SELECT source_updated.id, audit_written.audit_event_id
    FROM source_updated
    JOIN audit_written ON TRUE
  `) as Array<{ id: string; audit_event_id: string }>;
  const row = rows[0];
  if (!row) throw makeError('NOT_FOUND', `source ${id} not found`, 404);
  if (!row.audit_event_id) throw new Error('source sync missing audit receipt');
  return {
    source_sync_receipt_id: sourceSyncReceipt(row.id, result, row.audit_event_id),
    audit_event_id: row.audit_event_id,
  };
}

/** 044 · restore a soft-disconnected source (clears the marker, back to 'connected'). */
export async function reconnectUserSourceRow(sql: Sql, userId: UserId, id: string): Promise<void> {
  if (!userId) throw new Error('reconnectUserSource: userId required');
  if (!id) throw new Error('reconnectUserSource: id required');
  await sql`
    UPDATE user_source_connections
    SET status = 'connected', disconnected_at = NULL, updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
  `;
}

/** G2 (write 25) · set a source's access tier (read_policy). OWNERSHIP-scoped (user_id + id in the WHERE)
 *  so a caller can only retier a source they own — a non-owned/absent id resolves to no row (404). Reuses
 *  the 016 enum. Pre-067 (column absent) surfaces a clean 409 so the route can degrade instead of 500. */
export async function setUserSourceReadPolicyRow(
  sql: Sql,
  userId: UserId,
  id: string,
  readPolicy: SourceReadPolicy,
  workspaceId?: WorkspaceId | null,
): Promise<SourceReadPolicyWriteReceipt> {
  if (!userId) throw makeError('UNAUTHORIZED', 'user required', 401);
  if (!id) throw makeError('VALIDATION_ERROR', 'id required', 400);
  if (!VALID_READ_POLICIES.has(readPolicy)) {
    throw makeError('VALIDATION_ERROR', `read_policy must be one of: ${Array.from(VALID_READ_POLICIES).join(', ')}`, 422);
  }
  let rows: Record<string, unknown>[];
  try {
    rows = (await sql`
      WITH source_updated AS (
        UPDATE user_source_connections
        SET read_policy = ${readPolicy}, updated_at = now()
        WHERE id = ${id} AND user_id = ${userId} AND disconnected_at IS NULL
        RETURNING id, workspace_id, user_id, provider, provider_user_id, provider_username,
                  scopes, contract, status, read_policy, connected_at, last_sync_at, last_sync_error,
                  created_at, updated_at
      ),
      audit_written AS (
        INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, metadata)
        SELECT ${userId},
               'source_read_policy_change'::text,
               CASE WHEN COALESCE(source_updated.workspace_id, ${workspaceId}) IS NULL THEN 'user' ELSE 'workspace' END,
               COALESCE(source_updated.workspace_id, ${workspaceId}, source_updated.user_id),
               COALESCE(source_updated.workspace_id, ${workspaceId}),
               ${'read_policy -> ' + readPolicy},
               jsonb_build_object('source_id', source_updated.id, 'provider', source_updated.provider, 'read_policy', source_updated.read_policy)
        FROM source_updated
        RETURNING id::text AS audit_event_id
      )
      SELECT source_updated.id, source_updated.workspace_id, source_updated.user_id, source_updated.provider,
             source_updated.provider_user_id, source_updated.provider_username, source_updated.scopes,
             source_updated.contract, source_updated.status, source_updated.read_policy,
             source_updated.connected_at, source_updated.last_sync_at, source_updated.last_sync_error,
             source_updated.created_at, source_updated.updated_at, audit_written.audit_event_id
      FROM source_updated
      JOIN audit_written ON TRUE
    `) as Record<string, unknown>[];
  } catch (err) {
    if (isUndefinedColumn(err)) {
      throw makeError('READ_POLICY_UNAVAILABLE', 'source access-level persistence requires migration 067 to be applied', 409);
    }
    throw err;
  }
  const row = rows[0];
  if (!row) throw makeError('NOT_FOUND', `source ${id} not found`, 404);
  const auditEventId = typeof row.audit_event_id === 'string' ? row.audit_event_id : '';
  if (!auditEventId) throw new Error('source read_policy write missing audit receipt');
  const source = rowToUserSourceConnection(row);
  return {
    source,
    read_policy_revision_id: `source-read-policy:${source.id}:${source.read_policy}:${auditEventId}`,
    audit_event_id: auditEventId,
  };
}
