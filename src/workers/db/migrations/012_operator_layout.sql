-- 012_operator_layout.sql · R52-B1 · operator-controlled layout persistence · 2026-05-29
--
-- Pillar 3 of the product vision: "restructurable in order — convenient for a
-- user how it is visible for it." This table persists each operator's chosen
-- ordering, hidden-set, and custom groupings of their Ecosystem → Workspace →
-- Project/Domain hierarchy, so the cockpit renders THEIR arrangement, not the
-- read-model's default emission order.
--
-- Scope (R52-B1 · backend persistence only):
--   1. CREATE TABLE operator_layout IF NOT EXISTS (one row per user_id)
--   2. Bump workers_schema_version to 12
--
-- Out of scope (lands in R52-B2/B3):
--   * Drag-reorder UI (B2)
--   * Hide/show + custom-group affordances (B3)
--   * Synthetic-domain → custom_group materialization (Stage D / D1)
--
-- layout JSONB shape (version 1):
--   {
--     "version": 1,
--     "workspace_order":   ["mbp-private","xcp-platform",...],   -- operator order
--     "hidden_workspaces": ["x-docs"],                            -- hidden from view
--     "project_order":     { "<workspace_id>": ["<project_id>",...] },
--     "hidden_projects":   ["<project_id>",...],
--     "custom_groups": [
--       { "id":"grp_...", "label":"Marathon prep", "member_ids":["<project_id>",...],
--         "kind":"user" | "synthetic_domain", "synthetic_domain_id":"<id>|null" }
--     ]
--   }
-- All keys optional; absent key ⇒ "use read-model default" for that dimension.
-- This makes the layout an OVERLAY, never a replacement — a project that exists
-- but isn't in project_order still renders (appended after ordered ones).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 12) THEN

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'operator_layout'
    ) THEN
      CREATE TABLE operator_layout (
        user_id     TEXT PRIMARY KEY,
        layout      JSONB NOT NULL DEFAULT '{"version":1}'::jsonb,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Fast lookup is by PK (user_id); no secondary index needed at this scale
      -- (one row per operator). updated_at supports staleness/observability.
      CREATE INDEX IF NOT EXISTS idx_operator_layout_updated
        ON operator_layout (updated_at DESC);
    END IF;

    INSERT INTO workers_schema_version (version, applied_at, description)
    VALUES (
      12,
      now(),
      'R52-B1 · operator_layout · per-operator restructurable ordering/hidden/custom-groups overlay (pillar 3)'
    );

  END IF;
END
$$;

COMMIT;
