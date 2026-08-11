// Dedicated connector OAuth persistence. This owner-side store is the only
// runtime surface allowed to read encrypted provider credentials.

import type { Sql } from '../db/client';
import type {
  ConnectorOAuthGrant,
  ConnectorOAuthGrantSecret,
  ConnectorOAuthGrantUpsertInput,
  OAuthProvider,
  UserId,
  UserSourceConnection,
} from './types';
import { makeError, randomNanoid } from './shared-helpers';
import { rowToUserSourceConnection } from './source-store';

const DEDICATED_GOOGLE_PROVIDERS: ReadonlySet<OAuthProvider> = new Set(['google_drive', 'gmail']);

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToGrant(row: Record<string, unknown>): ConnectorOAuthGrant {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    user_id: String(row.user_id),
    authority_provider: row.authority_provider as 'google',
    provider_account_id: String(row.provider_account_id),
    provider_label: row.provider_label == null ? null : String(row.provider_label),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    access_expires_at: toIso(row.access_expires_at),
    status: row.status as ConnectorOAuthGrant['status'],
    last_refresh_at: toIso(row.last_refresh_at),
    last_refresh_error: row.last_refresh_error == null ? null : String(row.last_refresh_error),
    revocation_verified_at: toIso(row.revocation_verified_at),
    created_at: toIso(row.created_at) ?? '',
    updated_at: toIso(row.updated_at) ?? '',
  };
}

export interface ConnectorOAuthStateNonceInput {
  nonce_hash: string;
  workspace_id: string;
  user_id: UserId;
  provider: 'google_drive' | 'gmail';
  expires_at: string;
}

export interface ConnectorOAuthConnectionInput extends ConnectorOAuthGrantUpsertInput {
  source_provider: 'google_drive' | 'gmail';
}

export interface ConnectorOAuthConnectionReceipt {
  grant: ConnectorOAuthGrant;
  source: UserSourceConnection;
  source_binding_id: string;
  connector_grant_receipt_id: string;
  audit_event_id: string;
}

export interface ConnectorOAuthDisconnectAuthority {
  authority: 'xlooop_connector_grant';
  authority_mode: 'dedicated_connector';
  oauth_grant_id: string;
  upstream_status: 'retained_shared' | 'revoked' | 'already_absent';
  identity_preserved: true;
  upstream_verified_at: string;
  request_id: string | null;
}

export interface ConnectorOAuthDisconnectReceipt {
  disconnected: { id: string; provider: string };
  disconnected_source_ids: string[];
  grant_status: 'active' | 'revoked';
  source_disconnect_receipt_id: string;
  audit_event_id: string;
}

export async function registerConnectorOAuthStateNonceRow(
  sql: Sql,
  input: ConnectorOAuthStateNonceInput,
): Promise<void> {
  if (!input.nonce_hash || !input.workspace_id || !input.user_id) {
    throw new Error('connector OAuth state nonce identity is incomplete');
  }
  await sql`
    INSERT INTO connector_oauth_state_nonces (
      nonce_hash, workspace_id, user_id, provider, expires_at
    ) VALUES (
      ${input.nonce_hash}, ${input.workspace_id}, ${input.user_id}, ${input.provider}, ${input.expires_at}
    )
    ON CONFLICT (nonce_hash) DO NOTHING
  `;
}

export async function claimConnectorOAuthStateNonceRow(
  sql: Sql,
  input: Omit<ConnectorOAuthStateNonceInput, 'expires_at'>,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE connector_oauth_state_nonces
    SET consumed_at = now()
    WHERE nonce_hash = ${input.nonce_hash}
      AND workspace_id = ${input.workspace_id}
      AND user_id = ${input.user_id}
      AND provider = ${input.provider}
      AND consumed_at IS NULL
      AND expires_at > now()
    RETURNING nonce_hash
  `) as Array<{ nonce_hash: string }>;
  return rows.length === 1;
}

export async function connectConnectorOAuthSourceRow(
  sql: Sql,
  input: ConnectorOAuthConnectionInput,
): Promise<ConnectorOAuthConnectionReceipt> {
  if (!input.workspace_id || !input.user_id || !input.id || !input.provider_account_id) {
    throw new Error('connector OAuth grant identity is incomplete');
  }
  if (!DEDICATED_GOOGLE_PROVIDERS.has(input.source_provider)) {
    throw new Error(`dedicated connector OAuth is unavailable for ${input.source_provider}`);
  }
  const sourceId = `usc_${randomNanoid()}`;
  const scopes = input.scopes ?? [];
  const rows = (await sql`
    WITH grant_written AS (
      INSERT INTO connector_oauth_grants (
        id, workspace_id, user_id, authority_provider, provider_account_id,
        provider_label, scopes, token_ciphertext, token_iv, access_expires_at,
        status, created_at, updated_at
      )
      SELECT
        ${input.id}, ${input.workspace_id}, ${input.user_id}, ${input.authority_provider},
        ${input.provider_account_id}, ${input.provider_label}, ${scopes}::text[],
        ${input.token_ciphertext}, ${input.token_iv}, ${input.access_expires_at},
        'active', now(), now()
      ON CONFLICT (workspace_id, user_id, authority_provider, provider_account_id)
      DO UPDATE SET
        provider_label = EXCLUDED.provider_label,
        scopes = EXCLUDED.scopes,
        token_ciphertext = EXCLUDED.token_ciphertext,
        token_iv = EXCLUDED.token_iv,
        access_expires_at = EXCLUDED.access_expires_at,
        status = 'active',
        last_refresh_error = NULL,
        revocation_verified_at = NULL,
        updated_at = now()
      RETURNING *
    ),
    source_written AS (
      INSERT INTO user_source_connections (
        id, workspace_id, user_id, provider, provider_user_id, provider_username,
        oauth_grant_id, scopes, contract, status, connected_at, created_at, updated_at
      )
      SELECT
        ${sourceId}, grant_written.workspace_id, grant_written.user_id, ${input.source_provider},
        grant_written.provider_account_id, grant_written.provider_label, grant_written.id,
        grant_written.scopes,
        '{"version":1,"ingestion_mode":"reflection_only","allowed_fields":["title","subject","timestamp","author_login"],"max_body_bytes":200,"rate_limit":{"per_hour":5000}}'::jsonb,
        'connected', now(), now(), now()
      FROM grant_written
      ON CONFLICT (workspace_id, user_id, provider)
        WHERE oauth_grant_id IS NOT NULL
      DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        provider_user_id = EXCLUDED.provider_user_id,
        provider_username = EXCLUDED.provider_username,
        oauth_grant_id = EXCLUDED.oauth_grant_id,
        scopes = EXCLUDED.scopes,
        status = 'connected',
        disconnected_at = NULL,
        updated_at = now()
      RETURNING *
    ),
    audit_written AS (
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, workspace_id, reason, metadata
      )
      SELECT
        source_written.user_id, 'source_connect', 'workspace', source_written.workspace_id,
        source_written.workspace_id, 'dedicated connector OAuth source connect',
        jsonb_build_object(
          'source_id', source_written.id,
          'provider', source_written.provider,
          'credential_authority', 'xlooop_connector_grant',
          'oauth_grant_id', source_written.oauth_grant_id
        )
      FROM source_written
      RETURNING id::text AS audit_event_id
    )
    SELECT
      grant_written.*,
      row_to_json(source_written) AS source_row,
      audit_written.audit_event_id
    FROM grant_written
    JOIN source_written ON source_written.oauth_grant_id = grant_written.id
    JOIN audit_written ON TRUE
  `) as Array<Record<string, unknown> & { source_row: Record<string, unknown>; audit_event_id: string }>;
  const row = rows[0];
  if (!row) {
    throw makeError('CONNECTOR_GRANT_WRITE_FAILED', 'dedicated connector grant write produced no receipt', 500);
  }
  const grant = rowToGrant(row);
  const source = rowToUserSourceConnection(row.source_row);
  if (!row.audit_event_id) throw new Error('dedicated connector source connect missing audit receipt');
  return {
    grant,
    source,
    source_binding_id: source.id,
    connector_grant_receipt_id: `connector-grant:${grant.id}:${row.audit_event_id}`,
    audit_event_id: row.audit_event_id,
  };
}

export async function getConnectorOAuthGrantSecretRow(
  sql: Sql,
  workspaceId: string,
  userId: UserId,
  grantId: string,
): Promise<ConnectorOAuthGrantSecret | null> {
  const rows = (await sql`
    SELECT *, token_ciphertext, token_iv
    FROM connector_oauth_grants
    WHERE id = ${grantId}
      AND workspace_id = ${workspaceId}
      AND user_id = ${userId}
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    ...rowToGrant(row),
    token_ciphertext: String(row.token_ciphertext || ''),
    token_iv: String(row.token_iv || ''),
  };
}

export async function updateConnectorOAuthGrantTokensRow(
  sql: Sql,
  input: Pick<ConnectorOAuthGrantUpsertInput,
    'id' | 'workspace_id' | 'user_id' | 'token_ciphertext' | 'token_iv' | 'scopes' | 'access_expires_at'>,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE connector_oauth_grants
    SET token_ciphertext = ${input.token_ciphertext},
        token_iv = ${input.token_iv},
        scopes = ${input.scopes}::text[],
        access_expires_at = ${input.access_expires_at},
        last_refresh_at = now(),
        last_refresh_error = NULL,
        status = 'active',
        updated_at = now()
    WHERE id = ${input.id}
      AND workspace_id = ${input.workspace_id}
      AND user_id = ${input.user_id}
      AND status IN ('active', 'refresh_required')
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length === 1;
}

export async function markConnectorOAuthGrantRefreshErrorRow(
  sql: Sql,
  input: { id: string; workspace_id: string; user_id: UserId; error: string },
): Promise<void> {
  await sql`
    UPDATE connector_oauth_grants
    SET status = 'refresh_required',
        last_refresh_error = ${input.error.slice(0, 500)},
        updated_at = now()
    WHERE id = ${input.id}
      AND workspace_id = ${input.workspace_id}
      AND user_id = ${input.user_id}
      AND status <> 'revoked'
  `;
}

export async function countActiveConnectorGrantSourcesRow(
  sql: Sql,
  workspaceId: string,
  userId: UserId,
  grantId: string,
): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM user_source_connections
    WHERE workspace_id = ${workspaceId}
      AND user_id = ${userId}
      AND oauth_grant_id = ${grantId}
      AND disconnected_at IS NULL
  `) as Array<{ count: number }>;
  return Number(rows[0]?.count || 0);
}

export async function disconnectConnectorOAuthSourceRow(
  sql: Sql,
  input: {
    workspace_id: string;
    user_id: UserId;
    source_id: string;
    authority: ConnectorOAuthDisconnectAuthority;
  },
): Promise<ConnectorOAuthDisconnectReceipt> {
  const authority = input.authority;
  if (authority.oauth_grant_id === '' || authority.identity_preserved !== true) {
    throw new Error('verified dedicated connector authority is required');
  }
  if (authority.upstream_status === 'retained_shared') {
    const rows = (await sql`
      WITH active_refs AS (
        SELECT count(*)::int AS count
        FROM user_source_connections
        WHERE workspace_id = ${input.workspace_id}
          AND user_id = ${input.user_id}
          AND oauth_grant_id = ${authority.oauth_grant_id}
          AND disconnected_at IS NULL
      ),
      source_disconnected AS (
        UPDATE user_source_connections
        SET status = 'disconnected', disconnected_at = now(), updated_at = now()
        WHERE id = ${input.source_id}
          AND workspace_id = ${input.workspace_id}
          AND user_id = ${input.user_id}
          AND oauth_grant_id = ${authority.oauth_grant_id}
          AND disconnected_at IS NULL
          AND (SELECT count FROM active_refs) > 1
        RETURNING id, provider
      ),
      audit_written AS (
        INSERT INTO audit_logs (
          actor_user_id, action, target_type, target_id, workspace_id, reason, metadata
        )
        SELECT
          ${input.user_id}, 'source_disconnect', 'workspace', ${input.workspace_id},
          ${input.workspace_id}, 'source disconnect; shared connector grant retained',
          jsonb_build_object(
            'source_id', source_disconnected.id,
            'provider', source_disconnected.provider,
            'upstream_revocation', ${JSON.stringify(authority)}::jsonb
          )
        FROM source_disconnected
        RETURNING id::text AS audit_event_id
      )
      SELECT source_disconnected.id, source_disconnected.provider, audit_written.audit_event_id
      FROM source_disconnected
      JOIN audit_written ON TRUE
    `) as Array<{ id: string; provider: string; audit_event_id: string }>;
    const row = rows[0];
    if (!row) throw makeError('SOURCE_GRANT_CARDINALITY_CHANGED', 'shared connector grant state changed; retry disconnect', 409);
    return {
      disconnected: { id: row.id, provider: row.provider },
      disconnected_source_ids: [row.id],
      grant_status: 'active',
      source_disconnect_receipt_id: `source-disconnect:${row.id}:${row.audit_event_id}`,
      audit_event_id: row.audit_event_id,
    };
  }

  const rows = (await sql`
    WITH grant_revoked AS (
      UPDATE connector_oauth_grants
      SET status = 'revoked',
          token_ciphertext = '',
          token_iv = '',
          access_expires_at = NULL,
          last_refresh_error = NULL,
          revocation_verified_at = ${authority.upstream_verified_at},
          updated_at = now()
      WHERE id = ${authority.oauth_grant_id}
        AND workspace_id = ${input.workspace_id}
        AND user_id = ${input.user_id}
        AND status <> 'revoked'
      RETURNING id
    ),
    sources_disconnected AS (
      UPDATE user_source_connections
      SET status = 'disconnected', disconnected_at = now(), updated_at = now()
      WHERE workspace_id = ${input.workspace_id}
        AND user_id = ${input.user_id}
        AND oauth_grant_id = (SELECT id FROM grant_revoked)
        AND disconnected_at IS NULL
      RETURNING id, provider
    ),
    target AS (
      SELECT id, provider
      FROM sources_disconnected
      WHERE id = ${input.source_id}
    ),
    source_ids AS (
      SELECT array_agg(id ORDER BY id) AS ids FROM sources_disconnected
    ),
    audit_written AS (
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, workspace_id, reason, metadata
      )
      SELECT
        ${input.user_id}, 'source_disconnect', 'workspace', ${input.workspace_id},
        ${input.workspace_id}, 'last connector source disconnected; upstream grant revoked',
        jsonb_build_object(
          'source_id', target.id,
          'provider', target.provider,
          'disconnected_source_ids', source_ids.ids,
          'upstream_revocation', ${JSON.stringify(authority)}::jsonb
        )
      FROM target
      JOIN source_ids ON TRUE
      RETURNING id::text AS audit_event_id
    )
    SELECT target.id, target.provider, source_ids.ids, audit_written.audit_event_id
    FROM target
    JOIN source_ids ON TRUE
    JOIN audit_written ON TRUE
  `) as Array<{ id: string; provider: string; ids: string[]; audit_event_id: string }>;
  const row = rows[0];
  if (!row) throw makeError('SOURCE_GRANT_CARDINALITY_CHANGED', 'connector grant state changed; retry disconnect', 409);
  return {
    disconnected: { id: row.id, provider: row.provider },
    disconnected_source_ids: Array.isArray(row.ids) ? row.ids : [row.id],
    grant_status: 'revoked',
    source_disconnect_receipt_id: `source-disconnect:${row.id}:${row.audit_event_id}`,
    audit_event_id: row.audit_event_id,
  };
}
