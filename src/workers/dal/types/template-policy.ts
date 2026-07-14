// types/template-policy.ts · customer-safe template/policy projection registry.
//
// These are effective backend projections, not MB-P governance source files.
// Raw graph, private memory, governance scoring, routing internals, private
// schemas, secrets, and broad-memory search surfaces must never appear here.

import type { ProjectId, UserId, WorkspaceId } from './identity';

export type TemplateSourcePackage =
  | 'xcp-platform-templates'
  | 'approved-mbp-projection'
  | 'customer-safe-pack';

export type TemplateAuthorityLevel =
  | 'platform_default'
  | 'approved_projection'
  | 'advisory_projection';

export type TemplateLifecycleState =
  | 'draft'
  | 'approved'
  | 'active'
  | 'deprecated'
  | 'archived';

export type TemplateBindingScope =
  | 'global'
  | 'vertical'
  | 'tenant'
  | 'workspace'
  | 'project';

export type TenantBindingState = 'active' | 'paused' | 'archived';
export type TemplateOverlayState = 'active' | 'paused' | 'archived';

export type PolicyKind =
  | 'security'
  | 'retention'
  | 'approval'
  | 'redaction'
  | 'tenancy'
  | 'tooling';

export type PolicyDecisionKind =
  | 'allow'
  | 'deny'
  | 'require_approval'
  | 'redact'
  | 'quarantine';

export type TemplateEvidenceClassification =
  | 'public_safe'
  | 'tenant_private'
  | 'operator_private'
  | 'platform_private';

export type TemplateEvidenceSourceKind =
  | 'template'
  | 'policy'
  | 'approval'
  | 'audit'
  | 'external_source';

export interface TemplateDefinition {
  id: string;
  template_key: string;
  name: string;
  description: string;
  category: string;
  source_package: TemplateSourcePackage;
  source_ref: string;
  authority_level: TemplateAuthorityLevel;
  created_at: string;
  updated_at: string;
}

export interface TemplateVersion {
  id: string;
  template_id: string;
  version: string;
  content_sha256: string;
  redacted_content: Record<string, unknown>;
  source_ref: string;
  source_sha: string;
  approval_ref: string;
  rollback_version_id: string | null;
  lifecycle_state: TemplateLifecycleState;
  effective_scope: Record<string, unknown>;
  created_at: string;
}

export interface TenantTemplateBinding {
  id: string;
  workspace_id: WorkspaceId;
  template_id: string;
  version_id: string;
  binding_scope: TemplateBindingScope;
  vertical: string | null;
  project_id: ProjectId | null;
  lifecycle_state: TenantBindingState;
  approved_by: UserId;
  approval_ref: string;
  created_at: string;
  updated_at: string;
}

export interface UserTemplateOverlay {
  id: string;
  workspace_id: WorkspaceId;
  user_id: UserId;
  template_id: string;
  overlay_json: Record<string, unknown>;
  lifecycle_state: TemplateOverlayState;
  created_at: string;
  updated_at: string;
}

export interface TemplateEvidenceRef {
  id: string;
  workspace_id: WorkspaceId;
  source_kind: TemplateEvidenceSourceKind;
  source_ref: string;
  content_sha256: string;
  classification: TemplateEvidenceClassification;
  redaction_status: 'redacted' | 'metadata_only' | 'not_required';
  created_at: string;
}

export interface TemplateAdminApproval {
  id: string;
  workspace_id: WorkspaceId;
  approval_ref: string;
  actor_user_id: UserId;
  action: string;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled';
  evidence_ref_id: string | null;
  rollback_snapshot_id: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface PolicyDefinition {
  id: string;
  policy_key: string;
  name: string;
  description: string;
  policy_kind: PolicyKind;
  source_ref: string;
  content_sha256: string;
  lifecycle_state: TemplateLifecycleState;
  created_at: string;
  updated_at: string;
}

export interface PolicyDecision {
  id: string;
  workspace_id: WorkspaceId;
  policy_id: string;
  actor_user_id: UserId;
  decision: PolicyDecisionKind;
  reason: string;
  evidence_ref_id: string | null;
  created_at: string;
}

export interface EffectiveTemplateSnapshot {
  id: string;
  workspace_id: WorkspaceId;
  template_id: string;
  user_id: UserId | null;
  snapshot_hash: string;
  effective_template: Record<string, unknown>;
  source_version_ids: string[];
  evidence_ref_ids: string[];
  created_at: string;
}

export interface EffectiveTemplateEnvelope {
  template_id: string;
  template_key: string;
  name: string;
  category: string;
  binding_scope: TemplateBindingScope;
  binding_scopes_applied: string[];
  version_id: string;
  version: string;
  source_version_ids: string[];
  content_sha256: string;
  approval_ref: string;
  approval_refs: string[];
  source_ref: string;
  source_refs: string[];
  source_sha: string;
  lifecycle_state: TemplateLifecycleState;
  effective_template: Record<string, unknown>;
  overlay_applied: boolean;
  resolution_order: string[];
  resolution_strategy: string;
  forbidden_override_keys: string[];
}

export interface TemplatePolicyListOpts {
  limit?: number;
  template_id?: string;
  template_key?: string;
  user_id?: UserId;
}

export interface TemplateAdminApprovalInput {
  id?: string;
  approval_ref: string;
  action: string;
  status?: TemplateAdminApproval['status'];
  evidence_ref_id?: string | null;
  rollback_snapshot_id?: string | null;
}

export type LearningSignalKind =
  | 'preference'
  | 'personal_rule'
  | 'personal_skill'
  | 'workflow_default'
  | 'correction'
  | 'tool_usage'
  | 'role_fit';

export type LearningSignalSourceKind =
  | 'explicit_user_action'
  | 'agent_observation'
  | 'tool_event'
  | 'evidence_feedback'
  | 'approval_feedback'
  | 'onboarding';

export type LearningSignalClassification =
  | 'user_private'
  | 'tenant_share_candidate'
  | 'tenant_shared'
  | 'platform_private';

export type LearningPromotionState =
  | 'private'
  | 'candidate'
  | 'approved_shared'
  | 'rejected'
  | 'archived';

export interface UserLearningSignal {
  id: string;
  workspace_id: WorkspaceId;
  user_id: UserId;
  signal_kind: LearningSignalKind;
  source_kind: LearningSignalSourceKind;
  signal_json: Record<string, unknown>;
  classification: LearningSignalClassification;
  promotion_state: LearningPromotionState;
  consent_ref: string | null;
  evidence_ref_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserLearningSignalInput {
  id?: string;
  signal_kind: LearningSignalKind;
  source_kind: LearningSignalSourceKind;
  signal_json: Record<string, unknown>;
  classification?: LearningSignalClassification;
  promotion_state?: LearningPromotionState;
  consent_ref?: string | null;
  evidence_ref_id?: string | null;
}

export interface EffectivePersonalizationProfile {
  schema_id: 'xlooop.effective_personalization_profile.v1';
  workspace_id: WorkspaceId;
  user_id: UserId;
  role_key: string;
  company_profile: {
    rules: Record<string, unknown>;
    skills: Record<string, unknown>;
    defaults: Record<string, unknown>;
    approval_refs: string[];
  };
  user_profile: {
    preferences: Record<string, unknown>;
    personal_rules: Record<string, unknown>;
    personal_skills: Record<string, unknown>;
    learned_defaults: Record<string, unknown>;
    source_signal_ids: string[];
  };
  effective_profile: Record<string, unknown>;
  privacy_model: 'private_by_default_with_explicit_company_promotion';
  forbidden_override_keys: string[];
}

export interface TenantLearningPromotion {
  id: string;
  workspace_id: WorkspaceId;
  source_user_id: UserId;
  promoted_by_user_id: UserId;
  signal_id: string;
  target_profile_key: string;
  promotion_payload: Record<string, unknown>;
  approval_ref: string;
  evidence_ref_id: string | null;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled';
  created_at: string;
  decided_at: string | null;
}

export interface TenantLearningPromotionInput {
  id?: string;
  source_user_id: UserId;
  signal_id: string;
  target_profile_key: string;
  promotion_payload: Record<string, unknown>;
  approval_ref: string;
  evidence_ref_id?: string | null;
  status?: TenantLearningPromotion['status'];
}
