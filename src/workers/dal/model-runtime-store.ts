// model-runtime-store.ts · Wave C (260708) · SQL for per-workspace model-runtime provider config
// (migration 053). All SQL for the model-runtimes surface lives here; the facade + adapter only delegate.
//
// SECURITY BOUNDARY: this store handles ONLY the opaque sealed credential ({ciphertext, iv, last4}). It
// never encrypts, decrypts, or sees plaintext or the master key — that is the ROUTE layer's job (it has
// ctx.env.MODEL_RUNTIME_ENC_KEY; the DAL is constructed with sql only). listProvidersRow deliberately does
// NOT select the ciphertext/iv columns (mask-by-construction) so a list read physically cannot leak the
// sealed key; only getProviderCredentialRow returns them, and only for the internal provider-call path.
// Every query is workspace-scoped (WHERE workspace_id = $w) so a caller only ever touches their own tenant.

import type { Sql } from '../db/client';
import type { UserId, WorkspaceId } from './types';

// The 13 canonical provider ids (snake_case — matches the 008 connector-registry convention + clean
// SQL/TS identifiers; the new-UI's kebab data-cmp ids map onto these at the UI boundary). Bound as the
// migration 053 provider CHECK — keep the two lists in lockstep.
export const MODEL_RUNTIME_PROVIDERS = [
  'anthropic', 'openai', 'google', 'mistral', 'deepseek', 'azure_openai', 'aws_bedrock', 'openrouter',
  'ollama', 'lm_studio', 'vllm', 'llama_cpp', 'custom',
] as const;
export type ModelRuntimeProvider = (typeof MODEL_RUNTIME_PROVIDERS)[number];
export function isModelRuntimeProvider(v: unknown): v is ModelRuntimeProvider {
  return typeof v === 'string' && (MODEL_RUNTIME_PROVIDERS as readonly string[]).includes(v);
}

export const RUNTIME_AUTH_KINDS = ['none', 'api_key', 'azure_key', 'aws_sigv4', 'custom'] as const;
export type RuntimeAuthKind = (typeof RUNTIME_AUTH_KINDS)[number];

// Static per-provider facts. auth_kind + whether a key/base_url is required are derivable from the
// provider (never taken from the client), and `locality` is the governance band the new-UI groups by
// (mirrors the L1/L2/L3 privacy axis: on-prem → first-party → external).
export interface ProviderSpec {
  auth_kind: RuntimeAuthKind;
  requires_key: boolean; // a credential MUST be present for a valid config
  requires_base_url: boolean; // a base_url MUST be present (local / azure / custom)
  locality: 'private' | 'anthropic' | 'external';
}
export const PROVIDER_SPECS: Record<ModelRuntimeProvider, ProviderSpec> = {
  anthropic: { auth_kind: 'api_key', requires_key: true, requires_base_url: false, locality: 'anthropic' },
  openai: { auth_kind: 'api_key', requires_key: true, requires_base_url: false, locality: 'external' },
  google: { auth_kind: 'api_key', requires_key: true, requires_base_url: false, locality: 'external' },
  mistral: { auth_kind: 'api_key', requires_key: true, requires_base_url: false, locality: 'external' },
  deepseek: { auth_kind: 'api_key', requires_key: true, requires_base_url: false, locality: 'external' },
  azure_openai: { auth_kind: 'azure_key', requires_key: true, requires_base_url: true, locality: 'external' },
  aws_bedrock: { auth_kind: 'aws_sigv4', requires_key: true, requires_base_url: false, locality: 'external' },
  openrouter: { auth_kind: 'api_key', requires_key: true, requires_base_url: false, locality: 'external' },
  ollama: { auth_kind: 'none', requires_key: false, requires_base_url: true, locality: 'private' },
  lm_studio: { auth_kind: 'none', requires_key: false, requires_base_url: true, locality: 'private' },
  vllm: { auth_kind: 'none', requires_key: false, requires_base_url: true, locality: 'private' },
  llama_cpp: { auth_kind: 'none', requires_key: false, requires_base_url: true, locality: 'private' },
  // The escape hatch: an arbitrary OpenAI-compatible endpoint. base_url required; a key is OPTIONAL.
  custom: { auth_kind: 'custom', requires_key: false, requires_base_url: true, locality: 'private' },
};

/** The masked, client-safe shape of a provider config row — NO ciphertext/iv (they are never selected). */
export interface ProviderConfigRow {
  id: string;
  provider: ModelRuntimeProvider;
  auth_kind: RuntimeAuthKind;
  base_url: string | null;
  model: string | null;
  credential_last4: string | null;
  enabled: boolean;
  is_default: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderConfigWriteReceipt {
  provider: ProviderConfigRow;
  provider_config_version_id: string;
  audit_event_id: string;
}

export interface ProviderConfigDeleteReceipt {
  provider: ModelRuntimeProvider;
  deleted_provider_config_id: string;
  provider_config_version_id: string;
  audit_event_id: string;
}

export interface ProviderDefaultWriteReceipt {
  provider: ProviderConfigRow;
  default_revision_id: string;
  audit_event_id: string;
}

/** The sealed credential (base64 ciphertext + iv), plus its auth_kind. Internal-only — never serialized. */
export interface SealedProviderCredential {
  auth_kind: RuntimeAuthKind;
  ciphertext: string | null;
  iv: string | null;
}

/** The upsert payload. `sealed` is the already-encrypted credential (route-produced) or null to preserve
 *  the existing credential on a metadata-only update (COALESCE keeps the stored key). */
export interface ProviderUpsertInput {
  auth_kind: RuntimeAuthKind;
  base_url: string | null;
  model: string | null;
  enabled: boolean;
  sealed: { ciphertext: string; iv: string; last4: string } | null;
}

// The client-safe RETURNING/SELECT column set is written out literally in each query below —
// deliberately WITHOUT credential_ciphertext / credential_iv, so a read path cannot leak the sealed key.

function providerConfigVersion(row: Pick<ProviderConfigRow, 'id' | 'updated_at'>): string {
  return `model-runtime-provider:${row.id}:${row.updated_at}`;
}

function deletedProviderConfigVersion(id: string, auditEventId: string): string {
  return `model-runtime-provider:${id}:deleted:${auditEventId}`;
}

function defaultRevision(row: Pick<ProviderConfigRow, 'id' | 'updated_at'>): string {
  return `model-runtime-default:${row.id}:${row.updated_at}`;
}

/** List a workspace's provider configs (masked — no ciphertext). Degrade-safe: [] pre-migration/on error. */
export async function listProvidersRow(sql: Sql, workspaceId: WorkspaceId): Promise<ProviderConfigRow[]> {
  if (!workspaceId) return [];
  try {
    const rows = (await sql/*sql*/`
      SELECT id, provider, auth_kind, base_url, model, credential_last4, enabled, is_default,
             created_by, created_at, updated_at
      FROM model_runtime_providers
      WHERE workspace_id = ${workspaceId}
      ORDER BY provider ASC
    `) as ProviderConfigRow[];
    return rows;
  } catch {
    return [];
  }
}

/** The sealed credential for one provider — INTERNAL ONLY (the provider-call decrypt path). Never sent to a client. */
export async function getProviderCredentialRow(sql: Sql, workspaceId: WorkspaceId, provider: ModelRuntimeProvider): Promise<SealedProviderCredential | null> {
  if (!workspaceId) return null;
  const rows = (await sql/*sql*/`
    SELECT auth_kind, credential_ciphertext AS ciphertext, credential_iv AS iv
    FROM model_runtime_providers
    WHERE workspace_id = ${workspaceId} AND provider = ${provider}
    LIMIT 1
  `) as Array<{ auth_kind: RuntimeAuthKind; ciphertext: string | null; iv: string | null }>;
  return rows[0] ?? null;
}

/** Upsert a provider config (audited). `sealed` null → metadata-only update preserving the stored credential. */
export async function upsertProviderRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  provider: ModelRuntimeProvider,
  input: ProviderUpsertInput,
  actorUserId: UserId,
): Promise<ProviderConfigWriteReceipt> {
  const id = 'mrp_' + crypto.randomUUID().replace(/-/g, '');
  const ct = input.sealed?.ciphertext ?? null;
  const iv = input.sealed?.iv ?? null;
  const last4 = input.sealed?.last4 ?? null;
  const reason = input.sealed ? 'set config + credential' : 'set config (credential preserved)';
  const rows = (await sql/*sql*/`
    WITH provider_written AS (
      INSERT INTO model_runtime_providers
        (id, workspace_id, provider, auth_kind, base_url, model,
         credential_ciphertext, credential_iv, credential_last4, enabled, created_by, updated_at)
      VALUES
        (${id}, ${workspaceId}, ${provider}, ${input.auth_kind}, ${input.base_url}, ${input.model},
         ${ct}, ${iv}, ${last4}, ${input.enabled}, ${actorUserId}, now())
      ON CONFLICT (workspace_id, provider) DO UPDATE SET
        auth_kind = EXCLUDED.auth_kind,
        base_url  = EXCLUDED.base_url,
        model     = EXCLUDED.model,
        enabled   = EXCLUDED.enabled,
        -- preserve the stored credential when the caller supplied none (a metadata-only update):
        credential_ciphertext = COALESCE(EXCLUDED.credential_ciphertext, model_runtime_providers.credential_ciphertext),
        credential_iv         = COALESCE(EXCLUDED.credential_iv, model_runtime_providers.credential_iv),
        credential_last4      = COALESCE(EXCLUDED.credential_last4, model_runtime_providers.credential_last4),
        updated_at = now()
      RETURNING id, provider, auth_kind, base_url, model, credential_last4, enabled, is_default, created_by, created_at, updated_at
    ),
    audit_written AS (
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      SELECT ${actorUserId}, 'model_runtime_provider_set'::text, 'model_runtime_provider', provider_written.id, ${workspaceId}, ${reason}
      FROM provider_written
      RETURNING id::text AS audit_event_id
    )
    SELECT provider_written.id, provider_written.provider, provider_written.auth_kind, provider_written.base_url,
           provider_written.model, provider_written.credential_last4, provider_written.enabled,
           provider_written.is_default, provider_written.created_by, provider_written.created_at,
           provider_written.updated_at, audit_written.audit_event_id
    FROM provider_written
    JOIN audit_written ON TRUE
  `) as Array<ProviderConfigRow & { audit_event_id: string }>;
  const row = rows[0];
  if (!row?.audit_event_id) throw new Error('model runtime provider write missing audit receipt');
  const { audit_event_id, ...providerRow } = row;
  return { provider: providerRow, provider_config_version_id: providerConfigVersion(providerRow), audit_event_id };
}

/** Delete a provider config (audited). Returns true iff a row was removed. */
export async function deleteProviderRow(sql: Sql, workspaceId: WorkspaceId, provider: ModelRuntimeProvider, actorUserId: UserId): Promise<ProviderConfigDeleteReceipt | null> {
  const rows = (await sql/*sql*/`
    WITH provider_deleted AS (
      DELETE FROM model_runtime_providers
      WHERE workspace_id = ${workspaceId} AND provider = ${provider}
      RETURNING id, provider
    ),
    audit_written AS (
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      SELECT ${actorUserId}, 'model_runtime_provider_delete'::text, 'model_runtime_provider', provider_deleted.id, ${workspaceId}, 'delete provider config'
      FROM provider_deleted
      RETURNING id::text AS audit_event_id
    )
    SELECT provider_deleted.id AS deleted_provider_config_id, provider_deleted.provider, audit_written.audit_event_id
    FROM provider_deleted
    JOIN audit_written ON TRUE
  `) as Array<{ deleted_provider_config_id: string; provider: ModelRuntimeProvider; audit_event_id: string }>;
  const row = rows[0];
  if (!row) return null;
  if (!row.audit_event_id) throw new Error('model runtime provider delete missing audit receipt');
  return {
    provider: row.provider,
    deleted_provider_config_id: row.deleted_provider_config_id,
    provider_config_version_id: deletedProviderConfigVersion(row.deleted_provider_config_id, row.audit_event_id),
    audit_event_id: row.audit_event_id,
  };
}

/** Flip the workspace default to `providerId` (audited governed change). Sets exactly one default per
 *  workspace in a single UPDATE (the partial unique index tolerates the transition). Returns the new
 *  default row, or null when the id is not in the workspace (caller should validate first). */
export async function setDefaultProviderRow(sql: Sql, workspaceId: WorkspaceId, providerId: string, actorUserId: UserId): Promise<ProviderDefaultWriteReceipt | null> {
  const rows = (await sql/*sql*/`
    WITH providers_updated AS (
      UPDATE model_runtime_providers
      SET is_default = (id = ${providerId}), updated_at = now()
      WHERE workspace_id = ${workspaceId}
      RETURNING id, provider, auth_kind, base_url, model, credential_last4, enabled, is_default, created_by, created_at, updated_at
    ),
    default_written AS (
      SELECT id, provider, auth_kind, base_url, model, credential_last4, enabled, is_default, created_by, created_at, updated_at
      FROM providers_updated
      WHERE id = ${providerId} AND is_default = TRUE
    ),
    audit_written AS (
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      SELECT ${actorUserId}, 'model_runtime_default_change'::text, 'model_runtime_provider', default_written.id, ${workspaceId}, ${'default -> ' + providerId}
      FROM default_written
      RETURNING id::text AS audit_event_id
    )
    SELECT default_written.id, default_written.provider, default_written.auth_kind, default_written.base_url,
           default_written.model, default_written.credential_last4, default_written.enabled,
           default_written.is_default, default_written.created_by, default_written.created_at,
           default_written.updated_at, audit_written.audit_event_id
    FROM default_written
    JOIN audit_written ON TRUE
  `) as Array<ProviderConfigRow & { audit_event_id: string }>;
  const row = rows[0];
  if (!row) return null;
  if (!row.audit_event_id) throw new Error('model runtime default write missing audit receipt');
  const { audit_event_id, ...providerRow } = row;
  return { provider: providerRow, default_revision_id: defaultRevision(providerRow), audit_event_id };
}

/** The caller's per-workspace session override (provider id), or null when unset. Degrade-safe. */
export async function getOverrideRow(sql: Sql, userId: UserId, workspaceId: WorkspaceId): Promise<string | null> {
  if (!userId || !workspaceId) return null;
  try {
    const rows = (await sql/*sql*/`
      SELECT provider_id FROM user_runtime_override
      WHERE user_id = ${userId} AND workspace_id = ${workspaceId} LIMIT 1
    `) as Array<{ provider_id: string }>;
    return rows[0]?.provider_id ?? null;
  } catch {
    return null;
  }
}

/** Set the caller's per-workspace session override (UPSERT). A personal session preference — not audited. */
export async function setOverrideRow(sql: Sql, userId: UserId, workspaceId: WorkspaceId, providerId: string): Promise<string> {
  await sql/*sql*/`
    INSERT INTO user_runtime_override (user_id, workspace_id, provider_id, updated_at)
    VALUES (${userId}, ${workspaceId}, ${providerId}, now())
    ON CONFLICT (user_id, workspace_id)
    DO UPDATE SET provider_id = EXCLUDED.provider_id, updated_at = now()
  `;
  return providerId;
}
