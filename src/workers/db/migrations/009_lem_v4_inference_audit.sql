-- 009_lem_v4_inference_audit.sql · R51-γ · LEM-v4 audit substrate · 2026-05-28
--
-- Materializes the 6 audit tables defined in
-- docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16.4 + §16.4.1, plus ALTERs
-- the existing synthetic_domain_recommendations table (created in migration
-- 007 R49' LEM-v3) to carry LEM-v4 fields (evidence_score,
-- composite_confidence, pattern_fingerprint, signal_contribution_breakdown).
--
-- Why this is additive over migration 007's table (not a replacement):
--   - LEM-v3 had a single 'confidence' field. LEM-v4 introduces evidence_score
--     (gate) + composite_confidence (per-recommendation signal-weighted score).
--   - Existing LEM-v3 rows survive: the new columns default to NULL.
--   - LEM-v4 emissions populate the new columns + insert a row in
--     inference_emissions linking back via recommendation_id FK.
--
-- New tables (6):
--   1. detector_config            · versioned config (weights, thresholds, signal_names)
--   2. inference_runs             · one row per cron tick / detector invocation
--   3. inference_signal_evals     · one row per candidate × signal evaluation
--   4. inference_emissions        · one row per emitted recommendation (FK to recommendations)
--   5. recommendation_rejections  · one row per operator reject + suppress-fingerprint
--   6. calibration_buckets        · one row per (pattern_kind, bucket_lower) tracking error
--
-- ALTER:
--   * synthetic_domain_recommendations: +4 LEM-v4 columns
--
-- Retention: ≥ 365 days for all 6 audit tables per §16.4. TTL job is the
-- responsibility of a future cron (Wave ζ); this migration only creates
-- the schema.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 9) THEN

    -- ============================================================
    -- detector_config · versioned · one row activates at a time
    -- ============================================================
    --
    -- Each emission references a detector_config.version_id so prior
    -- emissions remain reproducible even after weight retunes (§16.4).
    --
    -- weights      JSONB · keyed by signal name (14 entries per §16.4.1)
    -- thresholds   JSONB · {E_min, DAD_min, DDC_min, composite_confidence_min, ...}
    -- signal_names TEXT[] · ordered list of signals for deterministic eval
    -- activated_at NOT NULL · deactivated_at NULL = currently active
    --
    -- Only one row may have deactivated_at IS NULL at any time. Enforced
    -- by a partial unique index.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'detector_config'
    ) THEN
      CREATE TABLE detector_config (
        version_id TEXT PRIMARY KEY,
        weights JSONB NOT NULL,
        thresholds JSONB NOT NULL,
        signal_names TEXT[] NOT NULL,
        activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deactivated_at TIMESTAMPTZ,
        notes TEXT,
        created_by TEXT NOT NULL DEFAULT 'system',
        CONSTRAINT chk_dc_deactivated_after_activated
          CHECK (deactivated_at IS NULL OR deactivated_at >= activated_at)
      );
      -- At most one active row at a time
      CREATE UNIQUE INDEX uq_detector_config_active
        ON detector_config ((TRUE)) WHERE deactivated_at IS NULL;
      CREATE INDEX idx_detector_config_activated
        ON detector_config(activated_at DESC);
    END IF;

    -- ============================================================
    -- inference_runs · one row per detector invocation
    -- ============================================================
    --
    -- kind = 'scheduled_cron'   · normal periodic tick
    --      | 'manual_trigger'   · operator-triggered POST
    --      | 'self_maintenance' · self-maintenance loop run (§16.5)
    --      | 'error_budget_event' · auto-suspend / pause event (§16.4.3)
    --
    -- status = 'running' | 'completed' | 'failed'
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'inference_runs'
    ) THEN
      CREATE TABLE inference_runs (
        run_id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        detector_config_version_id TEXT NOT NULL REFERENCES detector_config(version_id),
        input_event_window_start TIMESTAMPTZ NOT NULL,
        input_event_window_end TIMESTAMPTZ NOT NULL,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        emission_count INTEGER NOT NULL DEFAULT 0,
        cost_ms INTEGER,
        kind TEXT NOT NULL DEFAULT 'scheduled_cron'
          CHECK (kind IN ('scheduled_cron','manual_trigger','self_maintenance','error_budget_event')),
        status TEXT NOT NULL DEFAULT 'running'
          CHECK (status IN ('running','completed','failed')),
        error_text TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT chk_ir_window_order
          CHECK (input_event_window_end >= input_event_window_start)
      );
      CREATE INDEX idx_inference_runs_started ON inference_runs(started_at DESC);
      CREATE INDEX idx_inference_runs_kind_status
        ON inference_runs(kind, status, started_at DESC);
      CREATE INDEX idx_inference_runs_config
        ON inference_runs(detector_config_version_id);
    END IF;

    -- ============================================================
    -- inference_signal_evals · one row per candidate × signal
    -- ============================================================
    --
    -- candidate_fingerprint is a stable hash of the candidate domain set
    -- (e.g. cf_hobby_career_health_finance). Different fingerprints
    -- = different candidate sets. Same run may evaluate many candidates.
    --
    -- raw_value        · pre-normalization (e.g. event count, days, jaccard)
    -- normalized_value · in [0,1] per §16.2
    -- weight_used      · from detector_config.weights at run time
    -- weighted_contribution · convenience = normalized_value * weight_used
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'inference_signal_evals'
    ) THEN
      CREATE TABLE inference_signal_evals (
        id BIGSERIAL PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES inference_runs(run_id) ON DELETE CASCADE,
        candidate_fingerprint TEXT NOT NULL,
        signal_name TEXT NOT NULL,
        raw_value NUMERIC NOT NULL,
        normalized_value NUMERIC NOT NULL
          CHECK (normalized_value BETWEEN 0 AND 1),
        weight_used NUMERIC NOT NULL
          CHECK (weight_used BETWEEN 0 AND 1),
        weighted_contribution NUMERIC NOT NULL
      );
      CREATE INDEX idx_ise_run ON inference_signal_evals(run_id);
      CREATE INDEX idx_ise_fingerprint
        ON inference_signal_evals(candidate_fingerprint, signal_name);
    END IF;

    -- ============================================================
    -- inference_emissions · one row per emitted recommendation
    -- ============================================================
    --
    -- FK to existing synthetic_domain_recommendations (created in 007).
    -- evidence_score is the deterministic gate (§16.1); composite_confidence
    -- is the σ-of-weighted-sum signal-derived confidence (§16.2).
    --
    -- signal_contribution_breakdown stores a per-signal {normalized, weight,
    -- contribution} object so the UI can render contribution bars (§16.4.1).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'inference_emissions'
    ) THEN
      CREATE TABLE inference_emissions (
        emission_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES inference_runs(run_id) ON DELETE CASCADE,
        recommendation_id TEXT NOT NULL REFERENCES synthetic_domain_recommendations(id) ON DELETE CASCADE,
        composite_confidence NUMERIC NOT NULL
          CHECK (composite_confidence BETWEEN 0 AND 1),
        evidence_score NUMERIC NOT NULL CHECK (evidence_score >= 0),
        evidence_score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
          -- {DAD: 5, EC: 80, DDC: 4, CDCC: 5} per §16.1
        pattern_fingerprint TEXT NOT NULL,
        signal_contribution_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
        binding_member_set TEXT[] NOT NULL DEFAULT '{}',
        proposed_synthetic_domain_label TEXT,
        emitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_ie_run ON inference_emissions(run_id);
      CREATE INDEX idx_ie_recommendation ON inference_emissions(recommendation_id);
      CREATE INDEX idx_ie_pattern ON inference_emissions(pattern_fingerprint);
      CREATE INDEX idx_ie_emitted ON inference_emissions(emitted_at DESC);
    END IF;

    -- ============================================================
    -- recommendation_rejections · anti-rec memory (§16.6)
    -- ============================================================
    --
    -- One row per operator reject. permanent_suppress_fingerprint is NULL
    -- unless the operator toggled "never suggest again" OR cooldown-extend
    -- self-maintenance loop (§16.5 loop 4) elevates to permanent after
    -- 3× rejects of same fingerprint.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'recommendation_rejections'
    ) THEN
      CREATE TABLE recommendation_rejections (
        id BIGSERIAL PRIMARY KEY,
        recommendation_id TEXT NOT NULL REFERENCES synthetic_domain_recommendations(id) ON DELETE CASCADE,
        rejected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        rejected_by TEXT NOT NULL,
        reason_text TEXT,
        reason_taxonomy TEXT
          CHECK (reason_taxonomy IS NULL OR reason_taxonomy IN (
            'not_relevant','too_broad','too_narrow','already_exists',
            'privacy_concern','wrong_grouping','timing','other'
          )),
        permanent_suppress_fingerprint TEXT,
        pattern_fingerprint_at_reject TEXT NOT NULL,
        reject_count_for_fingerprint INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_rr_recommendation ON recommendation_rejections(recommendation_id);
      CREATE INDEX idx_rr_fingerprint ON recommendation_rejections(pattern_fingerprint_at_reject);
      CREATE INDEX idx_rr_suppress
        ON recommendation_rejections(permanent_suppress_fingerprint)
        WHERE permanent_suppress_fingerprint IS NOT NULL;
      CREATE INDEX idx_rr_rejected_at ON recommendation_rejections(rejected_at DESC);
    END IF;

    -- ============================================================
    -- calibration_buckets · predicted-vs-actual acceptance tracking
    -- ============================================================
    --
    -- One row per (pattern_kind, bucket_lower). Bucket width is 0.10
    -- (so bucket_lower in {0.50, 0.60, 0.70, 0.80, 0.90}).
    -- calibration_error = |predicted_acceptance_rate - actual_acceptance_rate|.
    -- Trips weight-retune (§16.5 loop 5) when > 0.15 (§16.4.2).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'calibration_buckets'
    ) THEN
      CREATE TABLE calibration_buckets (
        id BIGSERIAL PRIMARY KEY,
        pattern_kind TEXT NOT NULL,
        bucket_lower NUMERIC NOT NULL CHECK (bucket_lower BETWEEN 0 AND 1),
        bucket_upper NUMERIC NOT NULL CHECK (bucket_upper BETWEEN 0 AND 1),
        predicted_acceptance_rate NUMERIC NOT NULL,
        actual_acceptance_rate NUMERIC NOT NULL,
        predicted_count INTEGER NOT NULL DEFAULT 0,
        accepted_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0,
        deferred_count INTEGER NOT NULL DEFAULT 0,
        calibration_error NUMERIC NOT NULL,
        window_started_at TIMESTAMPTZ NOT NULL,
        window_size_emissions INTEGER NOT NULL,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_cb_bucket_order CHECK (bucket_upper > bucket_lower),
        CONSTRAINT chk_cb_bucket_width CHECK ((bucket_upper - bucket_lower) <= 0.10001)
      );
      CREATE UNIQUE INDEX uq_calibration_buckets_key
        ON calibration_buckets(pattern_kind, bucket_lower, window_started_at);
      CREATE INDEX idx_cb_error
        ON calibration_buckets(calibration_error DESC)
        WHERE calibration_error > 0.15;
    END IF;

    -- ============================================================
    -- ALTER synthetic_domain_recommendations · LEM-v4 columns
    -- ============================================================
    --
    -- Existing 'confidence' (R49' LEM-v3) is preserved. New columns are
    -- nullable so legacy rows survive. LEM-v4 emissions populate them.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'synthetic_domain_recommendations'
        AND column_name = 'evidence_score'
    ) THEN
      ALTER TABLE synthetic_domain_recommendations
        ADD COLUMN evidence_score NUMERIC
          CHECK (evidence_score IS NULL OR evidence_score >= 0),
        ADD COLUMN composite_confidence NUMERIC
          CHECK (composite_confidence IS NULL OR composite_confidence BETWEEN 0 AND 1),
        ADD COLUMN pattern_fingerprint TEXT,
        ADD COLUMN signal_contribution_breakdown JSONB,
        ADD COLUMN detector_config_version_id TEXT
          REFERENCES detector_config(version_id);
      CREATE INDEX idx_sdrec_pattern_fingerprint
        ON synthetic_domain_recommendations(pattern_fingerprint)
        WHERE pattern_fingerprint IS NOT NULL;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (9, 'R51-γ LEM-v4 inference audit · 6 audit tables + ALTER recommendations', now());
  END IF;
END $$;

COMMIT;
