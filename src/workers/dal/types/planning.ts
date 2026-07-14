// types/planning.ts · Synthetic-domain planning layer — LEM-v3 PR-3 (DAL split from types.ts)

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ProjectId, UserId, WorkspaceId } from './identity';
import type { SyntheticDomainId } from './synthetic-domain';

// ============================================================
// R49' PR-3 · Planning layer (LEM-v3)
// ============================================================

export type SyntheticDomainRoadmapId = string;       // 'sdr_<nanoid>'
export type SyntheticDomainRoadmapItemId = string;   // 'sdri_<nanoid>'
export type SyntheticDomainGoalId = string;          // 'sdg_<nanoid>'

export type RoadmapStatus = 'draft' | 'active' | 'completed' | 'paused' | 'archived';
export type RoadmapItemStatus = 'planned' | 'in_progress' | 'blocked' | 'done' | 'skipped';
export type GoalStatus = 'proposed' | 'active' | 'achieved' | 'abandoned';

export interface SyntheticDomainRoadmap {
  id: SyntheticDomainRoadmapId;
  domain_id: SyntheticDomainId;
  workspace_id: WorkspaceId | null;
  title: string;
  description: string | null;
  target_date: string | null;
  status: RoadmapStatus;
  version: number;
  metadata: Record<string, any>;
  created_by: UserId;
  updated_by: UserId | null;
  created_at: string;
  updated_at: string;
}

export interface SyntheticDomainRoadmapItem {
  id: SyntheticDomainRoadmapItemId;
  roadmap_id: SyntheticDomainRoadmapId;
  domain_id: SyntheticDomainId;
  position: number;
  title: string;
  description: string | null;
  status: RoadmapItemStatus;
  target_date: string | null;
  derived_from_project_id: ProjectId | null;
  derived_from_event_id: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

/** Goal derivation kinds shipped in PR-3. Extensible later in PR-5+. */
export type GoalDerivationKind =
  | 'member_project_count'      // count of synthetic_domain_membership rows
  | 'project_status_count'      // count of member projects with specific status
  | 'event_count'               // count of operation_events scoped to member projects
  | 'sign_off_approved_count';  // count of approved sign_offs scoped to member projects

export interface GoalDerivation {
  kind: GoalDerivationKind;
  /** Filter parameters specific to the derivation kind (e.g., status='completed') */
  filter?: Record<string, any>;
}

export interface SyntheticDomainGoal {
  id: SyntheticDomainGoalId;
  domain_id: SyntheticDomainId;
  roadmap_id: SyntheticDomainRoadmapId | null;
  workspace_id: WorkspaceId | null;
  title: string;
  description: string | null;
  metric_name: string;
  metric_unit: string | null;
  target_value: number;
  current_value: number | null;
  current_value_updated_at: string | null;
  target_date: string | null;
  status: GoalStatus;
  derivation: GoalDerivation;
  metadata: Record<string, any>;
  created_by: UserId;
  updated_by: UserId | null;
  created_at: string;
  updated_at: string;
}

export interface SyntheticDomainGoalProgress {
  goal_id: SyntheticDomainGoalId;
  observed_at: string;
  value: number;
  source_signal_id: string | null;
}

export interface SyntheticDomainRoadmapCreateInput {
  id?: SyntheticDomainRoadmapId;
  domain_id: SyntheticDomainId;
  title: string;
  description?: string | null;
  target_date?: string | null;
  status?: RoadmapStatus;
  metadata?: Record<string, any>;
}

export interface SyntheticDomainRoadmapItemInput {
  id?: SyntheticDomainRoadmapItemId;
  title: string;
  description?: string | null;
  status?: RoadmapItemStatus;
  target_date?: string | null;
  derived_from_project_id?: ProjectId | null;
  derived_from_event_id?: string | null;
  metadata?: Record<string, any>;
}

export interface SyntheticDomainGoalCreateInput {
  id?: SyntheticDomainGoalId;
  domain_id: SyntheticDomainId;
  roadmap_id?: SyntheticDomainRoadmapId | null;
  title: string;
  description?: string | null;
  metric_name: string;
  metric_unit?: string | null;
  target_value: number;
  target_date?: string | null;
  status?: GoalStatus;
  derivation: GoalDerivation;
  metadata?: Record<string, any>;
  // SE-1 SMART-ER layer (mig 069) — all optional, additive.
  tier?: string | null;
  ikigai_axes?: string[];
  future_state?: string | null;
  review_cadence?: string | null;
  review_due?: string | null;
  source_goal_id?: string | null;
  goal_metric_contract?: Record<string, unknown> | null;
}
