-- 027_folder_binding_fk.sql · Phase D (ADR-XLOOP-IA-001) · fix the dangling folder_snapshots.binding_id · 2026-06-10
--
-- folder_snapshots.binding_id (026) was a bare TEXT PRIMARY KEY whose comment claimed it referenced
-- project_source_bindings, but NO foreign key existed and registration synthesized a throwaway
-- `fld-<uuid>` instead of creating the canonical project_source_bindings row (source_kind='desktop_folder',
-- migration 016). That made folder_snapshots a PARALLEL registry (HR-NO-PARALLEL-MODEL violation).
--
-- Phase D makes registration create the CANONICAL binding and key the baseline by that binding's id.
-- This migration adds the real FK so a baseline can never dangle, and `project_source_bindings` becomes
-- the single registry (folder_snapshots = diff-baseline only). It first deletes any orphan baseline
-- (baselines are disposable — they rebuild on the next sync), so the FK add is safe on ANY database.
-- Verified safe in prod: folder_snapshots = 0 rows at apply time.
--
-- Idempotent + version-guarded (mirrors 026). Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/027_folder_binding_fk.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 27) THEN
    -- Drop disposable orphan baselines (binding_id not present as a canonical binding) so the FK is safe.
    DELETE FROM folder_snapshots fs
      WHERE NOT EXISTS (SELECT 1 FROM project_source_bindings psb WHERE psb.id = fs.binding_id);

    -- Add the FK only if absent (constraint-level idempotency).
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_folder_snapshots_binding') THEN
      ALTER TABLE folder_snapshots
        ADD CONSTRAINT fk_folder_snapshots_binding
        FOREIGN KEY (binding_id) REFERENCES project_source_bindings(id) ON DELETE CASCADE;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (27, 'Phase D · folder_snapshots.binding_id FK -> project_source_bindings(id); psb is the registry', now());
  END IF;
END $$;

COMMIT;
