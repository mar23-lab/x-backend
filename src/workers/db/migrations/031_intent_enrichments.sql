-- 031_intent_enrichments.sql · packet/intent PRE-ENRICHMENT store (additive, idempotent, version-guarded) · 2026-06-11
-- The operator's "standard enrichment practice": an intent should arrive pre-enriched with pros/cons,
-- prior available resources (similar resolved tasks / patternable solutions), web sources, the best
-- execution path per expert-LLM recommendation, and quantifiable metrics. Today the slot is empty.
-- This side table (keyed 1:1 to intents.id, no hard FK — same loose coupling as 023) holds the GENERATED
-- enrichment with its own provenance (generated_by/model/confidence) so it can be regenerated. Apply:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/031_intent_enrichments.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 31) THEN
    CREATE TABLE IF NOT EXISTS intent_enrichments (
      intent_id        TEXT PRIMARY KEY,                    -- 1:1 with intents.id; NO hard FK (loose, like 023)
      pros             JSONB NOT NULL DEFAULT '[]'::jsonb,
      cons             JSONB NOT NULL DEFAULT '[]'::jsonb,
      prior_resources  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- similar resolved tasks / patternable solutions / ecosystem refs
      web_sources      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [] unless a real source is supplied (no fabricated URLs)
      recommended_path TEXT,                                -- best execution path per expert-LLM recommendation
      metrics          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- quantifiable metrics + scientific-approach notes
      confidence       REAL,                                -- 0..1
      generated_by     TEXT NOT NULL DEFAULT 'deterministic'
                         CHECK (generated_by IN ('claude','workers_ai','deterministic')),
      model            TEXT,                                -- model id when LLM-generated, else NULL
      status           TEXT NOT NULL DEFAULT 'generated'
                         CHECK (status IN ('generated','stale','dismissed')),
      generated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_intent_enrichments_generated ON intent_enrichments(generated_at DESC);

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (31, 'intent_enrichments: generated pre-enrichment (pros/cons/prior_resources/web_sources/recommended_path/metrics/confidence) keyed 1:1 to intents.id, additive', now());
  END IF;
END $$;

COMMIT;
