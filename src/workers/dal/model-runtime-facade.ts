// model-runtime-facade.ts · Wave C (260708) · the model-runtimes DAL surface as a sub-facade the
// WorkersDalAdapter delegates to (FROZEN_DECOMPOSE: the adapter grows by ONE field + ONE import, not by
// N methods). All SQL lives in ./model-runtime-store; these are thin delegations bound to the adapter's
// sql handle. getSql is a thunk so the sql handle is resolved lazily at each call.

import type { Sql } from '../db/client';
import type { UserId, WorkspaceId } from './types';
import {
  listProvidersRow,
  getProviderCredentialRow,
  upsertProviderRow,
  deleteProviderRow,
  setDefaultProviderRow,
  getOverrideRow,
  setOverrideRow,
  type ModelRuntimeProvider,
  type ProviderConfigRow,
  type ProviderUpsertInput,
  type SealedProviderCredential,
} from './model-runtime-store';

export interface ModelRuntimesFacade {
  /** A workspace's provider configs, masked (no ciphertext). Degrade-safe. */
  listProviders(workspaceId: WorkspaceId): Promise<ProviderConfigRow[]>;
  /** The sealed credential for one provider — INTERNAL ONLY (provider-call decrypt path); never serialized. */
  getProviderCredential(workspaceId: WorkspaceId, provider: ModelRuntimeProvider): Promise<SealedProviderCredential | null>;
  /** Upsert a provider config (audited). input.sealed null → metadata-only update, credential preserved. */
  upsertProvider(workspaceId: WorkspaceId, provider: ModelRuntimeProvider, input: ProviderUpsertInput, actorUserId: UserId): Promise<ProviderConfigRow>;
  /** Delete a provider config (audited). true iff a row was removed. */
  deleteProvider(workspaceId: WorkspaceId, provider: ModelRuntimeProvider, actorUserId: UserId): Promise<boolean>;
  /** Flip the workspace default (audited governed change). null when the id is not in the workspace. */
  setDefaultProvider(workspaceId: WorkspaceId, providerId: string, actorUserId: UserId): Promise<ProviderConfigRow | null>;
  /** The caller's per-workspace session override (provider id) or null. */
  getOverride(userId: UserId, workspaceId: WorkspaceId): Promise<string | null>;
  /** Set the caller's per-workspace session override (personal preference; not audited). */
  setOverride(userId: UserId, workspaceId: WorkspaceId, providerId: string): Promise<string>;
}

export function makeModelRuntimesFacade(getSql: () => Sql): ModelRuntimesFacade {
  return {
    listProviders: (workspaceId) => listProvidersRow(getSql(), workspaceId),
    getProviderCredential: (workspaceId, provider) => getProviderCredentialRow(getSql(), workspaceId, provider),
    upsertProvider: (workspaceId, provider, input, actorUserId) => upsertProviderRow(getSql(), workspaceId, provider, input, actorUserId),
    deleteProvider: (workspaceId, provider, actorUserId) => deleteProviderRow(getSql(), workspaceId, provider, actorUserId),
    setDefaultProvider: (workspaceId, providerId, actorUserId) => setDefaultProviderRow(getSql(), workspaceId, providerId, actorUserId),
    getOverride: (userId, workspaceId) => getOverrideRow(getSql(), userId, workspaceId),
    setOverride: (userId, workspaceId, providerId) => setOverrideRow(getSql(), userId, workspaceId, providerId),
  };
}
