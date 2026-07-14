-- 010_lem_v4_detector_config_seed.sql · R51-γ · 2026-05-28
--
-- Seeds the FIRST detector_config row (version_id 'dcv_r50_genesis_v1') with
-- the 14-signal taxonomy + initial weights + thresholds defined in
-- docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16.4.1 (initial values) +
-- §16.4.2 (operating defaults).
--
-- This is the "v1" prior. The first self-maintenance retune (§16.5 loop 1)
-- will emit a new version_id once the operator has ≥ 50 accept/reject
-- decisions on the books. Until then, this row is the active detector
-- config and every emission references it for reproducibility.
--
-- Signal weights are taken DIRECTLY from §16.4.1 detector_config example:
--   actor_co_occurrence        0.12
--   temporal_co_occurrence     0.10
--   artifact_cross_reference   0.08
--   sequence_pattern           0.07
--   dwell_concentration        0.07
--   keyword_co_occurrence      0.09
--   intent_keyword_density     0.06
--   tag_overlap                0.05
--   embedding_similarity       0.00   ← STUBBED in R50 (§16.2 + §16.5 loop 6)
--   parent_distance            0.07
--   membership_overlap         0.06
--   actor_jaccard              0.06
--   stated_goal_keyword_overlap 0.09
--   rollup_alignment           0.08
--   (sum ≈ 1.00 modulo embedding_similarity=0 stub)
--
-- Thresholds are §16.4.2 operating defaults:
--   E_min                      2.5
--   DAD_min                    3
--   DDC_min                    2
--   composite_confidence_min   0.50
--
-- Idempotent: ON CONFLICT DO NOTHING.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 10) THEN

    INSERT INTO detector_config (
      version_id,
      weights,
      thresholds,
      signal_names,
      activated_at,
      deactivated_at,
      notes,
      created_by
    ) VALUES (
      'dcv_r50_genesis_v1',
      -- Weights per §16.4.1 detector_config example
      '{
        "actor_co_occurrence":        0.12,
        "temporal_co_occurrence":     0.10,
        "artifact_cross_reference":   0.08,
        "sequence_pattern":           0.07,
        "dwell_concentration":        0.07,
        "keyword_co_occurrence":      0.09,
        "intent_keyword_density":     0.06,
        "tag_overlap":                0.05,
        "embedding_similarity":       0.00,
        "parent_distance":            0.07,
        "membership_overlap":         0.06,
        "actor_jaccard":              0.06,
        "stated_goal_keyword_overlap":0.09,
        "rollup_alignment":           0.08
      }'::jsonb,
      -- Thresholds per §16.4.2 operating defaults
      '{
        "E_min":                       2.5,
        "DAD_min":                     3,
        "DDC_min":                     2,
        "composite_confidence_min":    0.50,
        "lookback_window_days":        30,
        "cooldown_window_days":        7,
        "permanent_suppress_threshold":3,
        "precision_target":            0.70,
        "precision_floor":             0.50,
        "calibration_error_retune_trigger": 0.15,
        "shadow_eval_window_days":     30,
        "cooccurrence_bucket_B_hours": 24,
        "rolling_precision_window":    50,
        "weight_retune_action_threshold": 50,
        "triage_notification_expiry_rate_threshold": 0.30,
        "triage_notification_time_to_decision_days": 7
      }'::jsonb,
      ARRAY[
        'actor_co_occurrence','temporal_co_occurrence','artifact_cross_reference',
        'sequence_pattern','dwell_concentration','keyword_co_occurrence',
        'intent_keyword_density','tag_overlap','embedding_similarity',
        'parent_distance','membership_overlap','actor_jaccard',
        'stated_goal_keyword_overlap','rollup_alignment'
      ]::TEXT[],
      now(),
      NULL,  -- still active
      'R51-γ genesis seed (per XLOOOP_SYSTEM_DESIGN_v1.md §16.4.1 + §16.4.2)',
      'system'
    )
    ON CONFLICT (version_id) DO NOTHING;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (10, 'R51-γ LEM-v4 detector_config genesis seed (14 signals + thresholds)', now());
  END IF;
END $$;

COMMIT;
