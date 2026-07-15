import type { ProjectId, UserId, WorkspaceId } from './identity';

export type IntakeOperation =
  | 'answer'
  | 'plan'
  | 'create_work'
  | 'continue_work'
  | 'decide'
  | 'inspect'
  | 'unresolved';

export type IntakeRisk = 'low' | 'medium' | 'high';
export type IntakeResolutionStatus = 'pending' | 'consumed' | 'expired' | 'cancelled';

export interface IntakeTarget {
  type: 'task_packet' | 'approval' | 'read_model' | 'none';
  id: string | null;
  label: string;
}

export interface IntakeContextSummary {
  reference_count: number;
  source_count: number;
  evidence_count: number;
}

export interface IntakeResolution {
  id: string;
  workspace_id: WorkspaceId;
  actor_user_id: UserId;
  project_id: ProjectId | null;
  client_request_id: string;
  request_digest: string;
  operation: IntakeOperation;
  confidence: number;
  ambiguity: boolean;
  target: IntakeTarget;
  effect_summary: string;
  risk: IntakeRisk;
  authority: { allowed: boolean; safe_reason: string };
  context_summary: IntakeContextSummary;
  required_tools: string[];
  requires_confirmation: boolean;
  next_step: 'answer_now' | 'draft_plan' | 'confirm' | 'clarify' | 'blocked';
  action_payload: Record<string, unknown>;
  current_work_version: number;
  version: number;
  status: IntakeResolutionStatus;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface IntakeResolutionInput {
  project_id?: ProjectId | null;
  client_request_id: string;
  request_digest: string;
  operation: IntakeOperation;
  confidence: number;
  ambiguity: boolean;
  target: IntakeTarget;
  effect_summary: string;
  risk: IntakeRisk;
  authority: IntakeResolution['authority'];
  context_summary: IntakeContextSummary;
  required_tools?: string[];
  requires_confirmation: boolean;
  next_step: IntakeResolution['next_step'];
  action_payload?: Record<string, unknown>;
  current_work_version?: number;
  expires_at: string;
}

export interface GovernedExecutionReceipt {
  id: string;
  workspace_id: WorkspaceId;
  resolution_id: string;
  actor_user_id: UserId;
  client_request_id: string;
  operation: IntakeOperation;
  target_type: IntakeTarget['type'];
  target_id: string | null;
  result: 'completed';
  effect_summary: string;
  created_at: string;
}

export type IntakeExecutionResult =
  | { ok: true; replayed?: boolean; resolution: IntakeResolution; receipt: GovernedExecutionReceipt; packet_id?: string }
  | { ok: false; reason: 'not_found' | 'stale' | 'expired' | 'already_consumed' | 'unsupported' };
