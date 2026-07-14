// types.ts · shared types matching Xlooop API contract V1
//
// Source-of-truth for these shapes lives in the Worker DAL types
// (src/workers/dal/types.ts in the parent repo). Kept in sync at the API
// envelope level; tenant-specific extra fields are tolerated.

export type WorkspaceId = string;
export type ProjectId = string;
export type UserId = string;
export type EventId = string;
export type SignOffId = string;

/** R40 session-endpoint response shape (4 states). */
export interface SessionResponse {
  state: 'approved_workspace' | 'authenticated_no_access' | 'pending_access' | 'access_denied';
  user: { id: UserId; email: string; role: string } | null;
  workspace: { id: WorkspaceId; name: string; slug: string | null } | null;
  projects: Array<{ id: ProjectId; name: string; status: string }>;
  message?: string;
  access_request_id?: string;
  principal?: unknown;
  operator_bootstrapped?: { workspace_id: WorkspaceId; workspace_name: string };
}

export interface OperationEvent {
  id: EventId;
  workspace_id: WorkspaceId;
  project_id: ProjectId | null;
  source_tool: string;
  actor?: string;
  status: string;
  summary: string;
  body?: string;
  visibility: string;
  occurred_at: string;
  created_at?: string;
  [extra: string]: unknown; // tenants may extend
}

export interface EventListResponse {
  events: OperationEvent[];
  next_cursor: string | null;
}

export interface Project {
  id: ProjectId;
  workspace_id: WorkspaceId;
  name: string;
  status: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  /** R45: declarative filter for events that filter into project detail view. */
  scope_binding?: ProjectScopeBinding | null;
  scope_binding_updated_at?: string | null;
  scope_binding_updated_by?: UserId | null;
  [extra: string]: unknown;
}

export type ProjectScopeFilterType =
  | 'actor_in'
  | 'source_tool_in'
  | 'status_in'
  | 'visibility_in';

export interface ProjectScopeFilter {
  type: ProjectScopeFilterType;
  values: string[];
}

export interface ProjectScopeBinding {
  version: 1;
  combine: 'any' | 'all';
  filters: ProjectScopeFilter[];
}

export interface ProjectListResponse {
  projects: Project[];
}

export interface BoardCard {
  id: string;
  workspace_id: WorkspaceId;
  project_id: ProjectId | null;
  title: string;
  status: string;
  [extra: string]: unknown;
}

export interface BoardCardsResponse {
  cards: BoardCard[];
}

export interface SignOff {
  id: SignOffId;
  workspace_id: WorkspaceId;
  project_id: ProjectId | null;
  proposed_by: UserId;
  reviewer_user_id: UserId | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reason?: string;
  proposed_at: string;
  reviewed_at?: string;
  [extra: string]: unknown;
}

/** Input for POST /api/v1/events (idempotent on id). */
export interface EventAppendInput {
  id?: EventId; // operator-supplied for idempotency
  project_id?: ProjectId;
  source_tool: string;
  status: string;
  summary: string;
  body?: string;
  visibility?: string;
  occurred_at?: string;
  actor?: string;
  [extra: string]: unknown;
}

/** Input for POST /api/v1/sign-offs. */
export interface SignOffCreateInput {
  project_id?: ProjectId;
  event_id?: EventId;
  reviewer_user_id?: UserId;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/** Structured MCP error response shape. */
export interface ApiErrorBody {
  error: string;
  code: string;
  request_id?: string;
}
