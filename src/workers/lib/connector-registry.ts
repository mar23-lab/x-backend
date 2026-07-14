// connector-registry.ts · Wave C2 (2026-06-15) · the SINGLE SOURCE OF TRUTH for connector metadata.
//
// Before this, the provider list (label, description, tier, clerk slug) was hardcoded in the frontend
// SourceConnectorModal AND implied by the backend OAuthProvider taxonomy + translator registry — three
// places to keep in lockstep. This module is the SSOT; `GET /api/v1/connectors` serves it so the modal
// is data-driven (one place to add a provider). The `capabilities` field declares which scoped picker a
// provider supports (C3): GitHub → repos, Drive/Dropbox → folders.
//
// Tier reflects the Clerk free-plan cap (3 active social connections; see CLERK_OAUTH_PROVIDER_CONFIG.md).
// The taxonomy stays in lockstep with src/workers/dal/types/oauth.ts (OAuthProvider) + translators/index.ts
// (TRANSLATOR_REGISTRY) — adding a provider means: enum + translator + a row here.

import type { OAuthProvider } from '../dal/types/oauth';

export type ConnectorTier = 'free_active' | 'paid_queued';
export type ConnectorCapability = 'repos' | 'folders';

export interface ConnectorDescriptor {
  /** Our internal provider id — matches OAuthProvider + the /sources/connect/:provider path param. */
  id: OAuthProvider;
  label: string;
  description: string;
  tier: ConnectorTier;
  /** Clerk OAuth strategy slug (the `oauth_<slug>` passed to createExternalAccount). */
  clerk_slug: string;
  /** Scoped-picker capability (C3). `null` = connect-all (no scoping UI yet). */
  capability: ConnectorCapability | null;
  /**
   * Restricted mailbox scopes such as gmail.readonly must never be treated as
   * blanket social sign-in scopes. They are allowed only on the source-connect
   * path until live non-test-user proof says otherwise.
   */
  restricted_scope_mode?: 'connect_time_only';
  /** T1/P3 (260710) · the concrete restricted OAuth scope URLs `restricted_scope_mode` refers to.
   *  FE passes these as `additionalScopes` on the CONNECT-time createExternalAccount (never at sign-in);
   *  BE verifies they were actually granted before materializing the source row (flag-gated). */
  restricted_scopes?: readonly string[];
}

export const CONNECTOR_REGISTRY: readonly ConnectorDescriptor[] = Object.freeze([
  { id: 'github', label: 'GitHub', description: 'Commits, PRs, issues (metadata only)', tier: 'free_active', clerk_slug: 'github', capability: 'repos' },
  { id: 'google_drive', label: 'Google Drive', description: 'Folder + file metadata (no content download)', tier: 'free_active', clerk_slug: 'google', capability: 'folders' },
  { id: 'gmail', label: 'Gmail', description: 'Recent email metadata — From/Subject/Date + snippet, read-only (never the full body)', tier: 'free_active', clerk_slug: 'google', capability: null, restricted_scope_mode: 'connect_time_only', restricted_scopes: Object.freeze(['https://www.googleapis.com/auth/gmail.readonly']) },
  { id: 'dropbox', label: 'Dropbox', description: 'Folder metadata (cursor pagination)', tier: 'free_active', clerk_slug: 'dropbox', capability: 'folders' },
  { id: 'gitlab', label: 'GitLab', description: 'Commits, MRs, issues', tier: 'paid_queued', clerk_slug: 'gitlab', capability: 'repos' },
  { id: 'microsoft_onedrive', label: 'Microsoft OneDrive', description: 'OneDrive recent files via Microsoft Graph', tier: 'paid_queued', clerk_slug: 'microsoft', capability: 'folders' },
]);

/** The wire shape served by GET /api/v1/connectors (frozen; safe to JSON.stringify). */
export function buildConnectorCatalog(): { connectors: ConnectorDescriptor[]; free_tier_cap: number } {
  return { connectors: CONNECTOR_REGISTRY.map((c) => ({ ...c })), free_tier_cap: 3 };
}
