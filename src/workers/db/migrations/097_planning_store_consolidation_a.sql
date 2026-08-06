-- 097_planning_store_consolidation_a.sql · §1c Migration A (Step 1 of 6) — ADDITIVE, INERT.
--
-- Design authority: MB-P planning-store-consolidation-design-260806.md +
-- APP_XLOOOP_DESIGN_SYSTEM_AND_ARCHITECTURE.md §1c, realizing ADR-XB-002 (one scoped planning
-- model): plan_entities is the single canonical store; synthetic_domain_goals' metric spine and
-- the 069 SMART-ER layer move HERE; sister tables re-point in a LATER step. This migration has
-- ZERO runtime effect: columns are nullable, the kind CHECK is a strict superset of the current
-- vocabulary, the scope_type CHECK is NOT VALID (existing rows unscanned; validated at backfill).
--
-- Choreography (estate lessons, §1c item 3):
--   · The 066 inline kind CHECK is dropped by DISCOVERED pg_constraint name — 081's
--     guessed-literal trap: an inline CHECK's auto-name is an implementation detail.
--   · The reconciliation ledger is created HERE so Step-0 baselines and the Step-4 backfill write
--     to a table that exists before any data moves; RLS enabled with ZERO policies = owner-only
--     (092 fail-closed pattern) — the ledger is operator evidence, never customer data.
--   · The STATUS union-vocabulary CHECK is DEFERRED to the backfill step: a NOT VALID CHECK still
--     enforces on new writes, and the union vocabulary must be MEASURED from all three stores
--     first (design risk 5) — guessing it here could block live plan-facade writes.
--   · No grants change: plan_entities stays owner-connection-only (066 posture) until the
--     dual-write step decides otherwise under the 094/096 recipe.
--
-- Idempotent; version-guarded as 97; safe to re-run.

DO $$
DECLARE
  r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 97) THEN

    -- ── kind vocabulary: strict superset (legacy values retained during transition) ─────────────
    FOR r IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'plan_entities'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ~ '\(kind\y'
    LOOP
      EXECUTE format('ALTER TABLE plan_entities DROP CONSTRAINT %I', r.conname);
    END LOOP;
    ALTER TABLE plan_entities ADD CONSTRAINT plan_entities_kind_vocab_097
      CHECK (kind IN ('goal','milestone','todo','intent',
                      'objective','initiative','work_item','risk','proposal','roadmap'));

    -- ── scope_type vocabulary: NOT VALID — new writes conform, existing rows validated at backfill
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'plan_entities'::regclass AND conname = 'plan_entities_scope_type_vocab_097'
    ) THEN
      ALTER TABLE plan_entities ADD CONSTRAINT plan_entities_scope_type_vocab_097
        CHECK (scope_type IS NULL OR scope_type IN ('workspace','domain','project','lens'))
        NOT VALID;
    END IF;

    -- ── metric spine (ported from synthetic_domain_goals, mig 006) ──────────────────────────────
    ALTER TABLE plan_entities
      ADD COLUMN IF NOT EXISTS metric_name              TEXT,
      ADD COLUMN IF NOT EXISTS metric_unit              TEXT,
      ADD COLUMN IF NOT EXISTS target_value             NUMERIC,
      ADD COLUMN IF NOT EXISTS current_value            NUMERIC,
      ADD COLUMN IF NOT EXISTS current_value_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS derivation               JSONB;

    -- ── SMART-ER layer (ported from mig 069) ────────────────────────────────────────────────────
    ALTER TABLE plan_entities
      ADD COLUMN IF NOT EXISTS tier                 TEXT
        CHECK (tier IS NULL OR tier IN ('T0','T1','T2','T3')),
      ADD COLUMN IF NOT EXISTS ikigai_axes          TEXT[],
      ADD COLUMN IF NOT EXISTS future_state         TEXT,
      ADD COLUMN IF NOT EXISTS review_cadence       TEXT,
      ADD COLUMN IF NOT EXISTS review_due           DATE,
      ADD COLUMN IF NOT EXISTS source_goal_id       TEXT,
      ADD COLUMN IF NOT EXISTS goal_metric_contract JSONB;

    -- ── provenance for the reconciliation ledger (design item 1) ────────────────────────────────
    ALTER TABLE plan_entities
      ADD COLUMN IF NOT EXISTS source_table  TEXT,
      ADD COLUMN IF NOT EXISTS source_row_id TEXT;

    -- ── reconciliation ledger: every consolidation step writes its counts; a mismatch FAILS the
    --    step (design Step 0/Step 4). Owner-only by construction (RLS on, zero policies, no grants).
    CREATE TABLE IF NOT EXISTS planning_consolidation_ledger (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      step          TEXT NOT NULL,
      source_table  TEXT NOT NULL,
      rows_in       BIGINT NOT NULL,
      rows_migrated BIGINT NOT NULL DEFAULT 0,
      rows_tombstoned BIGINT NOT NULL DEFAULT 0,
      reconciled    BOOLEAN NOT NULL DEFAULT false,
      notes         TEXT,
      measured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE planning_consolidation_ledger ENABLE ROW LEVEL SECURITY;

    INSERT INTO workers_schema_version (version, description)
    VALUES (97, 'planning_store_consolidation_a: §1c Migration A — additive plan_entities superset (kind/scope_type vocab, metric spine, SMART-ER layer, provenance) + reconciliation ledger')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
