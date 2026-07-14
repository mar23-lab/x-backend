// types/propagation.ts · Propagation engine — LEM-v3 PR-5+6 signal layer (DAL split from types.ts)

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { EventStatus, SourceTool } from './event';
import type { EventId, ProjectId, UserId, WorkspaceId } from './identity';
import type { GoalStatus } from './planning';
import type { SyntheticDomainId } from './synthetic-domain';

// ============================================================
// R49' PR-5+6 · Propagation engine (LEM-v3 signal layer)
// ============================================================

export type PropagationRuleId = string;       // 'sdpr_<nanoid>'
export type RecommendationId = string;         // 'sdrec_<nanoid>'

export type PropagationRuleStatus = 'active' | 'paused' | 'archived';

/** Trigger: what conditions must hold for the rule to fire. */
export interface PropagationTrigger {
  /** Event-shape match (any field optional; AND of present fields) */
  event_pattern?: {
    status_in?: EventStatus[];
    source_tool_in?: SourceTool[];
    /** Minimum age of the event since occurred_at (seconds); useful for "blocked > 7d" */
    min_age_seconds?: number;
  };
  /** Goal-shape match (used for goal-driven recommendations like mark_goal_complete) */
  goal_pattern?: {
    /** Fire when current_value >= ratio * target_value (default 1.0) */
    completion_ratio_gte?: number;
    status_in?: GoalStatus[];
  };
  /** Don't fire more often than this window for the same (rule, source_event_id) */
  debounce_window_seconds?: number;
}

export type RecommendationKind =
  | 'extend_timeline'
  | 'add_goal'
  | 'add_roadmap_item'
  | 'mark_goal_complete'
  | 'mark_roadmap_item_complete'
  | 'flag_blocker'
  | 'reorder_roadmap'
  | 'update_member_set'
  | 'archive_domain';

/** Action: what recommendation to generate when the trigger fires. */
export interface PropagationAction {
  kind: RecommendationKind;
  /**
   * Template fragments interpolated into the recommendation's `payload` + `rationale`.
   * Variables: {event_id}, {project_id}, {goal_id}, {domain_id}, {value}, {target}
   */
  rationale_template?: string;
  /** Additional payload fields (literal; merged with computed fields) */
  payload_extra?: Record<string, any>;
  /** Hours until expires_at (default 168 = 7 days) */
  expiry_hours?: number;
  /** Confidence 0..1 (default 0.7) */
  confidence?: number;
}

export interface SyntheticDomainPropagationRule {
  id: PropagationRuleId;
  domain_id: SyntheticDomainId;
  workspace_id: WorkspaceId | null;
  name: string;
  description: string | null;
  trigger: PropagationTrigger;
  action: PropagationAction;
  status: PropagationRuleStatus;
  last_fired_at: string | null;
  fire_count: number;
  created_by: UserId;
  updated_by: UserId | null;
  created_at: string;
  updated_at: string;
}

export interface PropagationRuleCreateInput {
  id?: PropagationRuleId;
  domain_id: SyntheticDomainId;
  name: string;
  description?: string | null;
  trigger: PropagationTrigger;
  action: PropagationAction;
  status?: PropagationRuleStatus;
}

export type RecommendationStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'superseded';

export interface SyntheticDomainRecommendation {
  id: RecommendationId;
  domain_id: SyntheticDomainId;
  workspace_id: WorkspaceId | null;
  rule_id: PropagationRuleId | null;
  source_event_ids: EventId[];
  source_project_ids: ProjectId[];
  kind: RecommendationKind;
  payload: Record<string, any>;
  rationale: string;
  confidence: number;
  status: RecommendationStatus;
  generated_at: string;
  expires_at: string;
  acted_by: UserId | null;
  acted_at: string | null;
  resolution_note: string | null;
}

export interface RecommendationListOpts {
  domain_id?: SyntheticDomainId;
  status?: RecommendationStatus;
  limit?: number;
  // Tenant scope (audit 260531). When NEITHER domain_id NOR workspaceIds/includeCrossWorkspace
  // is provided, listRecommendations returns NOTHING (fail-closed) — never an unscoped
  // all-tenant read. workspaceIds = the caller's accessible workspaces; includeCrossWorkspace
  // additionally returns operator-only cross-workspace (workspace_id IS NULL) rows.
  workspaceIds?: string[];
  includeCrossWorkspace?: boolean;
}

export interface PropagationTickResult {
  ticks_run: number;
  events_seen: number;
  recommendations_generated: number;
  expired_count: number;
  last_event_ts: string | null;
  duration_ms: number;
  error?: string;
}
