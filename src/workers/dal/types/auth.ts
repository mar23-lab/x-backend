// types/auth.ts · Auth context, visibility & API error envelope (DAL split from types.ts)

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { UserId, WorkspaceId, WorkspaceRole } from './identity';

// ---- Visibility (per AUTH_TENANCY_MODEL.md) ----

export type Visibility =
  | 'internal_workspace'
  | 'internal_project'
  | 'internal_owner_only'
  | 'public_safe';

// ---- Auth context (injected by clerkAuth middleware; org_id is REQUIRED here) ----

export interface AuthContext {
  user_id: UserId;
  workspace_id: WorkspaceId;   // non-null guaranteed by clerkAuth (403s without org_id)
  role: WorkspaceRole;
  email?: string;
  is_admin?: boolean;          // derived from ADMIN_USER_IDS env var
  service_principal?: 'canary_read' | 'canary_lifecycle' | 'customer_token';
  auth_method?: 'clerk_jwt' | 'service_principal';
  token_expires_at?: string | null;
  client_id?: string;
  /**
   * Write-scope prefix for customer connector tokens (service_principal === 'customer_token').
   * Operator-role customer tokens may only write evidence/tool-events/approvals against task
   * packets whose id starts with this prefix. Unset for Clerk/canary auth. See mcp-gateway.ts.
   */
  packet_prefix?: string;
}

/**
 * Orgless auth context — used by routes that handle missing org_id themselves
 * (e.g. /session uses the entitlement state machine to return authenticated_no_access).
 * Set by clerkAuthAllowOrgless middleware.
 */
export interface OrglessAuthContext {
  user_id: UserId;
  workspace_id: WorkspaceId | null;
  role: WorkspaceRole;
  email?: string;
  is_admin?: boolean;
}

// ---- Standard error envelope ----

export interface ApiError {
  error: string;
  code: ApiErrorCode;
  request_id: string;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  // T1/P3 (260710) · source-connection contract codes. NB: errorEnvelope WHITELISTS codes — an unregistered
  // code silently downgrades to INTERNAL_ERROR on the wire (that latent bug hit SOURCE_WORKSPACE_BINDING_
  // REQUIRED at sources.ts sync since R50; registering both fixes the wire code while keeping the status).
  | 'SOURCE_WORKSPACE_BINDING_REQUIRED'
  | 'SOURCE_SCOPE_MISSING';
