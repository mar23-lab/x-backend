// types/event.ts · Events, projects, board cards & sign-offs (DAL split from types.ts)

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Visibility } from './auth';
import type { CardId, EventId, ProjectId, UserId, WorkspaceId, WorkspaceRole } from './identity';

// ---- Event status (R35.HARNESS-FLOW) ----

export type EventStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'needs_review'
  | 'completed'
  | 'failed'
  | 'approved'
  | 'rejected'
  | 'archived';

// ---- Source tool ----

export type SourceTool =
  | 'codex'
  | 'claude'
  | 'harness'
  | 'mbp'
  | 'xlooop'
  | 'operator'
  // R50.3a · Clerk OAuth source connectors (5 free-tier providers).
  // Must match migration 008_user_source_connections.sql CHECK constraint
  // and VALID_SOURCE_TOOLS in src/workers/routes/events.ts.
  | 'github'
  | 'google_drive'
  | 'dropbox'
  | 'gitlab'
  | 'microsoft_onedrive'
  // W3 · reflection-only folder connector (migration 026 extends the source_tool CHECK).
  | 'folder'
  // Wave C · S5b (260628) · picker-provider ingestion translators (migrations 039/040 extend both CHECKs).
  // W1 (260708) · spine unification — companion event emitted by createToolEventRow (migration 057).
  | 'tool_action'
  | 'gmail'
  | 'outlook'
  // P4 (260629) · SYSTEM-emitted direct-upload channel (the documents route emits the governed audit event).
  // Sibling to the google_drive/folder ingestion channels. Present in this type + the operation_events CHECK
  // (migration 041) but DELIBERATELY ABSENT from VALID_SOURCE_TOOLS — it is NOT caller-suppliable via
  // /events|/activity (a caller must not be able to spoof a document-upload provenance event).
  // See docs/engineering/INTAKE_CONTRACT.md §V3 (superset type/CHECK vs caller-intake subset).
  | 'document_upload';

// ---- Project status ----

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

// ---- Board card status ----

export type CardStatus = 'open' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived';

// ---- Sign-off verdict ----

export type SignOffVerdict = 'approved' | 'rejected' | 'noted';

// ---- Approval state ----

export type ApprovalState = 'pending' | 'approved' | 'rejected' | null;

// ---- Entity shapes (return values) ----

export interface SessionUser {
  id: UserId;
  email: string;
  role: WorkspaceRole;
}

export interface SessionWorkspace {
  id: WorkspaceId;
  name: string;
  slug: string | null;
}

export interface SessionProject {
  id: ProjectId;
  name: string;
  status: ProjectStatus;
}

export interface SessionContext {
  user: SessionUser;
  workspace: SessionWorkspace;
  projects: SessionProject[];
}

export interface HarnessFlowEvent {
  id: EventId;
  workspace_id: WorkspaceId;
  project_id: ProjectId | null;
  source_tool: SourceTool;
  agent_id: string | null;
  intent_id: string | null;
  status: EventStatus;
  summary: string;
  body: string | null;
  evidence_link: string | null;
  visibility: Visibility;
  permission_scope: string | null;
  risk: string | null;
  approval_state: ApprovalState;
  next_action: string | null;
  occurred_at: string;
  ingested_at?: string;
  archived_at?: string | null;
  // OS-4 P1 (migration 032) · comments-as-events thread pointer. A reply IS an append-only event
  // whose parent_event_id points at the top-level event it answers (GitHub-timeline model; flat
  // threads). An L1 ORGANIZATION pointer like project_id/intent_id — re-pointable, never content.
  parent_event_id?: string | null;
  // A-W4/P6 (050) · principal-instrument lineage on the READ surface. instrument_kind (the UI's actor-kind
  // display) + authority_source + request_id are SAFE enums/correlation, always exposed. authorized_by_user_id
  // is the raw human principal id — REDACTION-AWARE (A-W4.1): exposed to accountable roles (owner/operator/
  // member), nulled for the low-trust roles (client/viewer) and any public_safe surface, per
  // docs/governance/PRINCIPAL_INSTRUMENT_LINEAGE.md §Customer-safe redaction. See redactPrincipalForRole.
  authorized_by_user_id?: string | null;
  instrument_kind?: string | null;
  authority_source?: string | null;
  request_id?: string | null;
}

// Input for POST /api/v1/events (without server-computed fields)
export interface HarnessFlowEventInput {
  id: EventId;
  source_tool: SourceTool;
  agent_id?: string | null;
  project_id?: ProjectId | null;
  intent_id?: string | null;
  status: EventStatus;
  summary: string;
  body?: string | null;
  evidence_link?: string | null;
  visibility?: Visibility;
  permission_scope?: string | null;
  risk?: string | null;
  approval_state?: ApprovalState;
  next_action?: string | null;
  occurred_at: string;
  // R55-W2 · optional life-domain tag (normalized id, e.g. 'mb-p:health'). Migration
  // 014 added operation_events.domain_id (nullable). Lets the board scope by domain.
  domain_id?: string | null;
  // OS-4 P1 (migration 032) · thread pointer — the FIX#3 field the DAL previously DROPPED silently.
  parent_event_id?: string | null;
  // A-W4/P6 (migration 050) · principal-instrument actor lineage. Vocabulary SSOT:
  // src/workers/lib/actor-lineage.ts (UI-aligned: instrument_kind ∈ human|agent|system|external).
  // agent_id above remains the INSTRUMENT ID (≈ the new UI's `actor`); these add WHO AUTHORIZED it,
  // what KIND of instrument acted, under what AUTHORITY, and the HTTP correlation id.
  authorized_by_user_id?: string | null;
  instrument_kind?: string | null;
  authority_source?: string | null;
  request_id?: string | null;
}

export interface EventPagination {
  has_more: boolean;
  next_before: EventId | null;
}

export interface EventPage {
  events: HarnessFlowEvent[];
  pagination: EventPagination;
}

export interface EventListOpts {
  limit?: number;
  before?: EventId;
  project_id?: ProjectId;
  status?: EventStatus;
  source_tool?: SourceTool;
  role: WorkspaceRole; // required — used to derive visibility filter
  // OS-4 P1 · thread filters — OPT-IN ONLY (defaults unchanged: digest agent / read-models /
  // snapshots must not shift). parent_event_id=X fetches X's replies; top_level=true rolls up
  // (excludes replies). Mutually exclusive in practice; parent_event_id wins if both set.
  parent_event_id?: string;
  top_level?: boolean;
}

export interface UpsertResult {
  id: EventId;
  created: boolean;
}

// OS-3 UX Wave-2.1 · execution-pipeline status-transition patch.
// STATUS-CLASS FIELDS ONLY. ADR-XLOOP-IA-001 invariant (2) makes operation_events CONTENT columns
// (summary/title/payload/body/raw/content/description/kind/source_tool) APPEND-ONLY — they may never
// be UPDATEd. A row's content is immutable; re-organization is L1 re-pointing (status/approval_state/
// next_action/project_id/domain_id/intent_id) only. So an executor that produces NEW content (a
// digest body) must INSERT a fresh result event, never mutate the request row's body. Fields other
// than `status` are optional: when omitted the DAL leaves that column unchanged (COALESCE), so a
// claim ({status:'running'}) does not clobber an approval_state set elsewhere.
export interface EventStatusPatch {
  status: EventStatus;
  approval_state?: string | null;
  next_action?: string | null;
}

export interface Project {
  id: ProjectId;
  workspace_id: WorkspaceId;
  name: string;
  status: ProjectStatus;
  description: string | null;
  metadata: Record<string, any>;
  scope_binding: ProjectScopeBinding | null;
  scope_binding_updated_at: string | null;
  scope_binding_updated_by: UserId | null;
  /** R47.3 · self-ref parent for tree-nested domains (same workspace required). */
  parent_project_id: ProjectId | null;
  created_at: string;
  updated_at: string;
}

/** R47.3 · input for POST /api/v1/projects (operator creates domain or sub-domain). */
export interface ProjectCreateInput {
  id?: ProjectId;
  workspace_id: WorkspaceId;
  name: string;
  status?: ProjectStatus;
  description?: string;
  metadata?: Record<string, any>;
  parent_project_id?: ProjectId | null;
}

export interface ProjectListOpts {
  status?: ProjectStatus;
}

// R45 (2026-05-28): project scope_binding · declarative filter so events
// emitted at the workspace level (no project_id) can still flow into a
// project detail view based on actor/source_tool/status/visibility match.
export type ProjectScopeFilterType =
  | 'actor_in'
  | 'source_tool_in'
  | 'status_in'
  | 'visibility_in';

export interface ProjectScopeFilter {
  type: ProjectScopeFilterType;
  values: string[]; // each may use `*` wildcard suffix (e.g. "claude-session-*")
}

export interface ProjectScopeBinding {
  version: 1;
  combine: 'any' | 'all';
  filters: ProjectScopeFilter[];
}

export interface BoardCard {
  id: CardId;
  workspace_id: WorkspaceId;
  project_id: ProjectId;
  title: string;
  body: string | null;
  status: CardStatus;
  lane: string | null;
  assignee_id: UserId | null;
  event_id: EventId | null;
  evidence_link: string | null;
  position: number;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface BoardCardListOpts {
  lane?: string;
  status?: CardStatus;
}

export interface SignOffInput {
  event_id: EventId;
  verdict: SignOffVerdict;
  comment?: string | null;
  /** Distinguishes a review note from an explicit request to revise without widening the DB enum. */
  decision_kind?: 'approval' | 'rejection' | 'request_changes';
}

export interface SignOff {
  id: number;
  workspace_id: WorkspaceId;
  event_id: EventId;
  user_id: UserId;
  verdict: SignOffVerdict;
  comment: string | null;
  signed_at: string;
}
