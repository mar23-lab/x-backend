// types/inference.ts · LEM-v4 inference quality framework — R51-gamma (DAL split from types.ts)

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ProjectId } from './identity';
import type { RecommendationId } from './propagation';

// ============================================================
// R51-γ · LEM-v4 inference quality framework types
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16
// Migrations: 009_lem_v4_inference_audit.sql + 010_lem_v4_detector_config_seed.sql
// ============================================================

export type DetectorConfigVersionId = string; // 'dcv_<id>'
export type InferenceRunId = string;          // 'irn_<id>'
export type InferenceEmissionId = string;     // 'ie_<id>'

export type InferenceRunKind =
  | 'scheduled_cron'
  | 'manual_trigger'
  | 'self_maintenance'
  | 'error_budget_event';

export type InferenceRunStatus = 'running' | 'completed' | 'failed';

export type RejectionTaxonomy =
  | 'not_relevant'
  | 'too_broad'
  | 'too_narrow'
  | 'already_exists'
  | 'privacy_concern'
  | 'wrong_grouping'
  | 'timing'
  | 'other';

export interface DetectorConfig {
  version_id: DetectorConfigVersionId;
  weights: Record<string, number>;
  thresholds: Record<string, number>;
  signal_names: string[];
  activated_at: string;
  deactivated_at: string | null;
  notes: string | null;
  created_by: string;
}

export interface InferenceRun {
  run_id: InferenceRunId;
  started_at: string;
  completed_at: string | null;
  detector_config_version_id: DetectorConfigVersionId;
  input_event_window_start: string;
  input_event_window_end: string;
  candidate_count: number;
  emission_count: number;
  cost_ms: number | null;
  kind: InferenceRunKind;
  status: InferenceRunStatus;
  error_text: string | null;
  metadata: Record<string, any>;
}

export interface InferenceRunInput {
  run_id: InferenceRunId;
  detector_config_version_id: DetectorConfigVersionId;
  input_event_window_start: string;
  input_event_window_end: string;
  kind: InferenceRunKind;
}

export interface InferenceRunCompletion {
  run_id: InferenceRunId;
  candidate_count: number;
  emission_count: number;
  cost_ms: number;
  status: 'completed' | 'failed';
  error_text?: string | null;
  metadata?: Record<string, any>;
}

export interface InferenceSignalEvalInput {
  run_id: InferenceRunId;
  candidate_fingerprint: string;
  signal_name: string;
  raw_value: number;
  normalized_value: number;
  weight_used: number;
  weighted_contribution: number;
}

export interface InferenceEmission {
  emission_id: InferenceEmissionId;
  run_id: InferenceRunId;
  recommendation_id: RecommendationId;
  composite_confidence: number;
  evidence_score: number;
  evidence_score_breakdown: {
    DAD: number;
    EC: number;
    DDC: number;
    CDCC: number;
  };
  pattern_fingerprint: string;
  signal_contribution_breakdown: Record<
    string,
    { normalized: number; weight: number; contribution: number }
  >;
  binding_member_set: ProjectId[];
  proposed_synthetic_domain_label: string | null;
  emitted_at: string;
}

export interface InferenceEmissionInput {
  emission_id: InferenceEmissionId;
  run_id: InferenceRunId;
  recommendation_id: RecommendationId;
  composite_confidence: number;
  evidence_score: number;
  evidence_score_breakdown: {
    DAD: number;
    EC: number;
    DDC: number;
    CDCC: number;
  };
  pattern_fingerprint: string;
  signal_contribution_breakdown: Record<
    string,
    { normalized: number; weight: number; contribution: number }
  >;
  binding_member_set: ProjectId[];
  proposed_synthetic_domain_label?: string | null;
}

export interface RecommendationRejection {
  id: number;
  recommendation_id: RecommendationId;
  rejected_at: string;
  rejected_by: string;
  reason_text: string | null;
  reason_taxonomy: RejectionTaxonomy | null;
  permanent_suppress_fingerprint: string | null;
  pattern_fingerprint_at_reject: string;
  reject_count_for_fingerprint: number;
}

export interface RecommendationRejectionInput {
  recommendation_id: RecommendationId;
  rejected_by: string;
  pattern_fingerprint_at_reject: string;
  reason_text?: string | null;
  reason_taxonomy?: RejectionTaxonomy | null;
  permanent_suppress_fingerprint?: string | null;
}

export interface CalibrationBucket {
  id: number;
  pattern_kind: string;
  bucket_lower: number;
  bucket_upper: number;
  predicted_acceptance_rate: number;
  actual_acceptance_rate: number;
  predicted_count: number;
  accepted_count: number;
  rejected_count: number;
  deferred_count: number;
  calibration_error: number;
  window_started_at: string;
  window_size_emissions: number;
  computed_at: string;
}

export interface CalibrationBucketUpsertInput {
  pattern_kind: string;
  bucket_lower: number;
  bucket_upper: number;
  predicted_acceptance_rate: number;
  actual_acceptance_rate: number;
  predicted_count: number;
  accepted_count: number;
  rejected_count: number;
  deferred_count: number;
  calibration_error: number;
  window_started_at: string;
  window_size_emissions: number;
}
