-- 023_first_class_intents.sql · promote intent from a pointer to a first-class artefact (Wave 5b) · 2026-06-10
--
-- operation_events.intent_id (001_init) is a free-text pointer to NOTHING: there is no intents table,
-- so an "intent" has no title, status, owner, or lineage — the cockpit implies a first-class artefact
-- it does not have. This adds the intents table and BACKFILLS one row per distinct intent_id already
-- on operation_events, so every existing event's pointer resolves to a real artefact and lineage
-- (intent -> its child events) works immediately. No hard FK is added: operation_events.intent_id
-- stays loosely coupled (some pointers may predate / outlive their intent), matching the existing
-- coupling and keeping this purely ADDITIVE — no existing write path changes.
--
-- Idempotent + version-guarded (mirrors 020/021/022). Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/023_first_class_intents.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 23) THEN
    CREATE TABLE IF NOT EXISTS intents (
      id            TEXT PRIMARY KEY,        -- equals operation_events.intent_id for backfilled roots
      workspace_id  TEXT,
      project_id    TEXT,
      domain_id     TEXT,
      title         TEXT NOT NULL,
      summary       TEXT,
      status        TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'active', 'blocked', 'done', 'abandoned')),
      owner_user_id TEXT,
      derived_from  TEXT,                    -- parent intent id (lineage chain); NULL for roots
      origin        TEXT,                    -- 'operator' | 'agent' | 'backfill'
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_intents_workspace_time ON intents(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_intents_project ON intents(project_id) WHERE project_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_intents_derived ON intents(derived_from) WHERE derived_from IS NOT NULL;

    -- Backfill: one intent per distinct intent_id present on operation_events. Title is the pointer
    -- label (best available), summary is honest provenance, status='active' (it has live events),
    -- workspace/project/domain + owner taken from the earliest linked event's workspace. ON CONFLICT
    -- DO NOTHING keeps re-runs safe.
    INSERT INTO intents (id, workspace_id, project_id, domain_id, title, summary, status, owner_user_id, origin, created_at, updated_at)
    SELECT
      g.intent_id,
      g.workspace_id,
      g.project_id,
      g.domain_id,
      g.intent_id,
      'Backfilled from ' || g.n || ' linked event' || CASE WHEN g.n = 1 THEN '' ELSE 's' END,
      'active',
      w.owner_user_id,
      'backfill',
      g.first_at,
      now()
    FROM (
      SELECT
        intent_id,
        (array_agg(workspace_id ORDER BY occurred_at ASC))[1] AS workspace_id,
        (array_agg(project_id  ORDER BY occurred_at ASC))[1] AS project_id,
        (array_agg(domain_id   ORDER BY occurred_at ASC))[1] AS domain_id,
        MIN(occurred_at)                                      AS first_at,
        COUNT(*)                                              AS n
      FROM operation_events
      WHERE intent_id IS NOT NULL AND intent_id <> ''
      GROUP BY intent_id
    ) g
    LEFT JOIN workspaces w ON w.id = g.workspace_id
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (23, 'first-class intents (artefact + lineage) + backfill from operation_events.intent_id', now());
  END IF;
END $$;

COMMIT;
