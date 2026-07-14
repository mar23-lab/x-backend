// types/identity.ts · Identity, tenancy & RBAC types (DAL split from types.ts)
//
// Authority: API_CONTRACT_V1.md · DATABASE_SCHEMA_V1.md · R35.HARNESS-FLOW envelope
// Backend-agnostic seam shared between WorkersDalAdapter (Neon) and LocalDalAdapter.

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- R41 · Re-export canonical xcp-platform identity contract shape ----
//
// Xlooop consumes the public-safe xcp-platform contract pack. The Worker build
// uses this local mirror so Cloudflare deployment never depends on a sibling
// repo path.

export type {
  AuthenticatedPrincipal,
  AppEntitlement,
  AppEntitlementStatus,
  TenantMembership,
  MembershipRole,
  OperatingMode,
  XcpAppId,
  IdentitySource,
  AssuranceLevel,
  PlatformRole,
  TelemetryScope,
  AppAccessDecision,
} from './xcp-identity-contracts';

// ---- Identity & tenancy ----

export type WorkspaceId = string; // Clerk org ID, e.g. "org_2xK..."
export type UserId = string;      // Clerk user ID, e.g. "user_2yL..."
export type ProjectId = string;   // e.g. "proj_<nanoid>"
export type DomainId = string;    // e.g. "domain:mbp-private:governance"
export type EventId = string;     // e.g. "evt_<uuid>"
export type CardId = string;      // e.g. "card_<nanoid>"

// ---- Roles (RBAC) ----

export type WorkspaceRole = 'owner' | 'operator' | 'viewer' | 'client';

// R54-Stage3-C · operator-created workspaces (top-level containers owned by a
// user_id; not necessarily a Clerk org — the operator's personal workspaces use
// slug ids like 'xcp-platform'). Created via POST /api/v1/workspaces.
export interface WorkspaceRow {
  id: WorkspaceId;
  name: string;
  owner_user_id: UserId;
  slug: string | null;
  config: Record<string, any>;
  created_at: string;
  updated_at: string;
  // Stage 1 · land-on-real-work. Per-workspace recency signal = newest non-archived
  // operation_events.occurred_at (falling back to updated_at when the workspace has no
  // events yet). Present on the list path (listWorkspacesForOperatorRow); optional so
  // the create/update paths, which do not compute it, stay shape-compatible. Flows
  // through GET /api/v1/workspaces → live-workspaces-hydrator → window.SPACES, where
  // resolve-current-workspace's activityScore() picks it up to land the operator on
  // the most-recently-active workspace instead of list[0].
  last_event_at?: string | null;
}

export interface WorkspaceCreateInput {
  id?: WorkspaceId;
  name: string;
  slug?: string | null;
  config?: Record<string, any>;
}
