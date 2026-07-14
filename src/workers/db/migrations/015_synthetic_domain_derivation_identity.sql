-- 015_synthetic_domain_derivation_identity.sql · 2026-06-04
--
-- Stable synthetic-domain identity remains `synthetic_domains.id`.
-- Source-domain lineage and deterministic dedupe live separately as:
--   * source_domains
--   * derivation_fingerprint
--   * derivation_version
--   * derivative_mutation_allowed
--
-- This prevents source-domain membership changes from breaking URLs, roadmaps,
-- goals, todos, recommendations, and audit logs attached to the synthetic domain.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 15) THEN
    ALTER TABLE synthetic_domains
      ADD COLUMN IF NOT EXISTS source_domains TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      ADD COLUMN IF NOT EXISTS derivation_fingerprint TEXT,
      ADD COLUMN IF NOT EXISTS derivation_version INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS derivative_mutation_allowed TEXT[] NOT NULL DEFAULT ARRAY[
        'recommendation',
        'roadmap',
        'roadmap_item',
        'goal',
        'todo',
        'membership_binding',
        'progress_observation',
        'propagation_rule'
      ]::TEXT[];

    ALTER TABLE synthetic_domains
      DROP CONSTRAINT IF EXISTS chk_synthetic_derivation_fingerprint_shape;
    ALTER TABLE synthetic_domains
      ADD CONSTRAINT chk_synthetic_derivation_fingerprint_shape
      CHECK (
        derivation_fingerprint IS NULL
        OR derivation_fingerprint ~ '^sdsrc:sha256:[a-f0-9]{64}$'
      );

    ALTER TABLE synthetic_domains
      DROP CONSTRAINT IF EXISTS chk_synthetic_derivation_version_positive;
    ALTER TABLE synthetic_domains
      ADD CONSTRAINT chk_synthetic_derivation_version_positive
      CHECK (derivation_version >= 1);

    CREATE INDEX IF NOT EXISTS idx_sd_source_domains_gin
      ON synthetic_domains USING GIN (source_domains);
    CREATE INDEX IF NOT EXISTS idx_sd_derivation_fingerprint
      ON synthetic_domains(derivation_fingerprint)
      WHERE derivation_fingerprint IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (15, 'Synthetic-domain stable identity + source-domain lineage + derivation fingerprint', now());
  END IF;
END $$;

COMMIT;
