// types/operational-spine.ts · Customer-safe packet/evidence/approval/tool-event spine.
//
// Authority: backend-first Xlooop/XCP architecture · API_CONTRACT_V1 extension.
// These types are tenant-scoped operational projections, not MB-P governance SSOT
// and never raw graph/private memory exports.

import type { EventId, ProjectId, UserId, WorkspaceId } from './identity';

export type PacketLifecycleState =
  | 'draft'
  | 'ready'
  | 'in_progress'
  | 'evidence_ready'
  | 'approval_requested'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'archived';

export type ApprovalStatus = 'requested' | 'approved' | 'rejected' | 'cancelled';

export type EvidenceKind =
  | 'document'
  | 'screenshot'
  | 'log'
  | 'link'
  | 'commit'
  | 'metric'
  | 'receipt';

export type ToolEventAction =
  | 'get_task_packet'
  | 'get_allowed_scope'
  | 'submit_evidence'
  | 'report_tool_event'
  | 'request_approval'
  | 'get_workflow_status'
  | 'get_public_policy_summary'
  | 'get_effective_templates'
  | 'get_effective_profile'
  | 'submit_learning_signal';

export interface TaskPacket {
  id: string;
  workspace_id: WorkspaceId;
  project_id: ProjectId | null;
  event_id: EventId | null;
  title: string;
  summary: string;
  lifecycle_state: PacketLifecycleState;
  actor_user_id: UserId;
  allowed_tools: string[];
  forbidden_tools: string[];
  source_refs: string[];
  evidence_ref_ids: string[];
  approval_required: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskPacketInput {
  id?: string;
  project_id?: ProjectId | null;
  event_id?: EventId | null;
  title: string;
  summary: string;
  lifecycle_state?: PacketLifecycleState;
  allowed_tools?: string[];
  forbidden_tools?: string[];
  source_refs?: string[];
  approval_required?: boolean;
  expires_at?: string | null;
}

export interface EvidenceItem {
  id: string;
  workspace_id: WorkspaceId;
  packet_id: string | null;
  event_id: EventId | null;
  kind: EvidenceKind;
  title: string;
  uri: string;
  content_hash: string | null;
  summary: string | null;
  redaction_status: 'redacted' | 'metadata_only' | 'not_required';
  actor_user_id: UserId;
  created_at: string;
}

export interface EvidenceItemInput {
  id?: string;
  packet_id?: string | null;
  event_id?: EventId | null;
  kind: EvidenceKind;
  title: string;
  uri: string;
  content_hash?: string | null;
  summary?: string | null;
  redaction_status?: EvidenceItem['redaction_status'];
}

export interface ApprovalRequest {
  id: string;
  workspace_id: WorkspaceId;
  packet_id: string | null;
  event_id: EventId | null;
  requested_by: UserId;
  decided_by: UserId | null;
  status: ApprovalStatus;
  reason: string;
  decision_comment: string | null;
  requested_at: string;
  decided_at: string | null;
}

export interface ApprovalRequestInput {
  id?: string;
  packet_id?: string | null;
  event_id?: EventId | null;
  reason: string;
}

export interface ApprovalDecisionInput {
  status: Extract<ApprovalStatus, 'approved' | 'rejected' | 'cancelled'>;
  decision_comment?: string | null;
}

export interface ToolEvent {
  id: string;
  workspace_id: WorkspaceId;
  packet_id: string | null;
  /** W1 (260708) · companion spine-event backref (migration 057). Null on legacy/flag-off rows. */
  event_id?: string | null;
  tool_name: string;
  action: ToolEventAction;
  actor_user_id: UserId;
  status: 'allowed' | 'denied' | 'completed' | 'failed';
  evidence_item_id: string | null;
  summary: string;
  created_at: string;
}

export interface ToolEventInput {
  id?: string;
  packet_id?: string | null;
  tool_name: string;
  action: ToolEventAction;
  status: ToolEvent['status'];
  evidence_item_id?: string | null;
  summary: string;
}

export interface MetricDelta {
  id: string;
  workspace_id: WorkspaceId;
  packet_id: string | null;
  metric_id: string;
  before_value: number | null;
  after_value: number | null;
  delta_value: number | null;
  evidence_item_id: string | null;
  recorded_by: UserId;
  recorded_at: string;
}

export interface MetricDeltaInput {
  id?: string;
  packet_id?: string | null;
  metric_id: string;
  before_value?: number | null;
  after_value?: number | null;
  evidence_item_id?: string | null;
}

export type CustomerDataLifecycleKind = 'export' | 'delete';

export interface CustomerDataLifecycleExecutionInput {
  approval_id: string;
  request_kind: CustomerDataLifecycleKind;
  target_packet_id?: string | null;
  execution_note?: string | null;
}

export interface CustomerDataLifecycleExecution {
  request_kind: CustomerDataLifecycleKind;
  status: 'executed';
  approval_id: string;
  target_packet_id: string | null;
  archived_packet_ids: string[];
  evidence_item: EvidenceItem;
  tool_event: ToolEvent;
}

export interface OperationalSpineListOpts {
  limit?: number;
  packet_id?: string;
}
