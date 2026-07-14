-- 066_plan_entities.sql · G1 (260711) · customer plan entities (goal/milestone/todo/intent) — STAGED until operator applies.
--
-- WHY (the whole plan surface 404s today): the NEW-UI cockpit assumes a member-scoped plan facade
-- (`/plan/:scopeId`, `/plan/entity`, `/plan/entity/:id`) backing 8 writes (create goal/milestone/todo/
-- intent, rename, reorder, delete). The two EXISTING analogs — synthetic_domain_* and intents — are
-- OPERATOR-lens-scoped and cannot be opened to customers without a scope remodel, and neither closes
-- reorder/delete for goals/milestones/intents. One customer-scoped `plan_entities` table is cleaner
-- than bending either (net-new customer surface, not a duplicate of the operator planning model).
--
-- Additive + idempotent, no backfill. The consuming route is flag-gated (PLAN_ENTITIES_ENABLED, default
-- OFF → 404/501) AND degrades if this table is absent, so deploying the code before this migration
-- applies is byte-identical to today. RLS second layer mirrors the 045/065 workspace-policy recipe.
--
-- Validate against a throwaway local Postgres before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 66) THEN

    CREATE TABLE IF NOT EXISTS plan_entities (
      id                    TEXT PRIMARY KEY,
      workspace_id          TEXT NOT NULL,
      scope_id              TEXT,
      scope_type            TEXT,
      parent_id             TEXT REFERENCES plan_entities(id),
      kind                  TEXT CHECK (kind IN ('goal','milestone','todo','intent')),
      title                 TEXT NOT NULL,
      summary               TEXT,
      status                TEXT DEFAULT 'open',
      position              INTEGER NOT NULL DEFAULT 0,
      target_date           DATE,
      derived_from          TEXT,
      promoted_to_intent_id TEXT,
      deleted_at            TIMESTAMPTZ,
      created_by            TEXT,
      updated_by            TEXT,
      created_at            TIMESTAMPTZ DEFAULT now(),
      updated_at            TIMESTAMPTZ DEFAULT now()
    );

    -- Active-row read paths filter (workspace_id, scope_id) with deleted_at IS NULL.
    CREATE INDEX IF NOT EXISTS plan_entities_scope_active_idx
      ON plan_entities (workspace_id, scope_id) WHERE deleted_at IS NULL;

    -- Sibling ordering integrity: within a parent, positions are unique among ACTIVE rows only — a
    -- soft-deleted row keeps its old position, and the delete re-pack moves an active row onto that
    -- number, so uniqueness must exclude deleted rows (044 partial-unique gotcha; allows re-create).
    -- NOTE: parent_id NULL (top-level) rows are index-exempt (SQL NULLs are distinct) — top-level
    -- ordering is packed per (workspace_id, scope_id) by the store, not enforced here.
    CREATE UNIQUE INDEX IF NOT EXISTS plan_entities_parent_position_idx
      ON plan_entities (parent_id, position) WHERE deleted_at IS NULL;

    -- RLS second layer (045/065 recipe): the restricted RLS-subject client sees only its GUC workspace.
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE plan_entities ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS plan_entities_workspace_policy ON plan_entities;
      CREATE POLICY plan_entities_workspace_policy ON plan_entities
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (66, 'plan_entities (goal/milestone/todo/intent) — customer plan facade table + workspace RLS + partial-unique(parent_id,position)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT count(*) FROM information_schema.tables WHERE table_name='plan_entities';
--   SELECT indexname FROM pg_indexes WHERE tablename='plan_entities';
--   SELECT relrowsecurity FROM pg_class WHERE relname='plan_entities';                 -- expect t (if RLS fn present)
--   SELECT policyname, cmd FROM pg_policies WHERE tablename='plan_entities';
