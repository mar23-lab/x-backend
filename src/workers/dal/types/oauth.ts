// types/oauth.ts · OAuth source connectors & Clerk adapter contracts (DAL split from types.ts)

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { UserId } from './identity';

// ---- R50.3b · Clerk OAuth source connectors ----
//
// Provider-id taxonomy used by Xlooop's user_source_connections table.
// These are the same 5 values as the `source_tool` enum subset above,
// but typed explicitly to make routes / adapters that ONLY accept OAuth
// providers self-documenting.
export type OAuthProvider =
  | 'github'
  | 'google_drive'
  | 'dropbox'
  | 'gitlab'
  | 'microsoft_onedrive'
  | 'gmail' // Wave C · S5b (260628) · first picker-provider translator; reuses the Clerk `google` provider (+ gmail.readonly scope)
  | 'outlook'; // Wave C · S5b (260628) · reuses the Clerk `microsoft` provider (+ Mail.Read scope), like microsoft_onedrive

// Mapping from our internal OAuthProvider id to the Clerk SDK provider
// argument (post-v1.13 the `oauth_` prefix is deprecated; pass the bare name).
// Note: our `microsoft_onedrive` maps to Clerk's bare `microsoft` because
// Clerk does not distinguish OneDrive from other Microsoft Graph surfaces
// at the OAuth level — scope selection is done in the dashboard.
export const OAUTH_PROVIDER_TO_CLERK_SLUG: Record<OAuthProvider, string> = {
  github: 'github',
  google_drive: 'google',
  dropbox: 'dropbox',
  gitlab: 'gitlab',
  microsoft_onedrive: 'microsoft',
  gmail: 'google', // same Clerk Google provider as google_drive; restricted scope must be proven at source-connect time
  outlook: 'microsoft', // same Clerk Microsoft provider as microsoft_onedrive; Mail.Read must be proven at source-connect time
};

// R50.3a contract JSONB shape (matches migration 008 default value).
// R50.3c contract-enforcer reads this to validate emitted events before INSERT.
export interface SourceConnectionContract {
  version: 1;
  ingestion_mode: 'reflection_only';
  allowed_fields: string[];
  max_body_bytes: number;
  rate_limit: { per_hour: number };
}

export type UserSourceConnectionStatus =
  | 'connected'
  | 'disconnected'
  | 'revoked'
  | 'error'
  | 'pending';

// G2 (migration 067) · per-source access tier. REUSES the exact 016 project_source_bindings vocabulary
// so services/source-tier.ts readPolicyToTier maps unchanged: metadata_only→Index, read_only→Rely,
// proposal_only→Operate. Do NOT invent a new enum.
export type SourceReadPolicy = 'metadata_only' | 'proposal_only' | 'read_only';

// Mirrors a row from the `user_source_connections` table.
export interface UserSourceConnection {
  id: string;
  workspace_id: string | null;
  user_id: UserId;
  provider: OAuthProvider;
  provider_user_id: string | null;
  provider_username: string | null;
  scopes: string[];
  contract: SourceConnectionContract;
  status: UserSourceConnectionStatus;
  read_policy: SourceReadPolicy; // G2 (migration 067) · per-source access tier; defaults to 'metadata_only'
  connected_at: string; // ISO8601
  last_sync_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
}

// Upsert input for user_source_connections. The DAL fills in id/timestamps.
export interface UserSourceConnectionInput {
  workspace_id: string | null;
  user_id: UserId;
  provider: OAuthProvider;
  provider_user_id: string | null;
  provider_username: string | null;
  scopes: string[];
  contract?: SourceConnectionContract; // optional · falls back to migration-008 default
  status?: UserSourceConnectionStatus;  // defaults to 'connected'
}

// R50.3b clerk-oauth-adapter error taxonomy. Routes map these to HTTP statuses.
export type OAuthAdapterErrorCode =
  | 'OAUTH_NOT_CONNECTED'        // user hasn't authorized this provider yet
  | 'OAUTH_TOKEN_EXPIRED'        // Clerk returned a token but Clerk reports expiry
  | 'OAUTH_REVOKED'              // token was revoked by user or by provider
  | 'OAUTH_PROVIDER_NOT_CONFIGURED' // provider isn't enabled in Clerk dashboard
  | 'OAUTH_INVALID_PROVIDER'     // caller passed a provider not in OAuthProvider union
  | 'OAUTH_CLERK_API_ERROR';     // generic catch-all for Clerk-side errors

export interface OAuthAdapterError extends Error {
  code: OAuthAdapterErrorCode;
  provider?: OAuthProvider;
  user_id?: UserId;
  clerk_status?: number;
  clerk_message?: string;
}

// Successful return from clerk-oauth-adapter.getAccessToken().
// Clerk returns at most one active token per (user, provider) so we flatten
// the paginated SDK response into a single object.
export interface OAuthAccessTokenSnapshot {
  provider: OAuthProvider;
  token: string;
  external_account_id: string;
  scopes: string[];
  label: string | null;
  fetched_at: string; // ISO8601 (timestamp of this fetch; for cache TTL)
}
