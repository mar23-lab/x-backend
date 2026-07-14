-- 007_propagation_engine.sql · R49' LEM-v3 PR-5+6 · 2026-05-28
--
-- Adds the signal propagation layer:
--   * synthetic_domain_propagation_rules · operator-authored if-then rules
--   * synthetic_domain_recommendations    · advisory entities (pending/accepted/rejected)
--   * propagation_tick_state              · single-row table tracking last worker tick
--
-- Propagation worker (Cron Trigger every 60s, see index.ts):
--   1. Read new operation_events since last_tick
--   2. For each event, find synthetic_domains whose binding matches the event's project
--   3. For each matching domain, evaluate each active propagation_rule
--   4. If rule trigger matches event, generate a pending recommendation
--   5. For each active goal, recompute current_value; if >= target, generate
--      mark_goal_complete recommendation
--   6. Expire pending recommendations past expires_at
--   7. Update last_tick
--
-- Recommendations are ADVISORY: the worker never mutates roadmaps, goals, or
-- member set directly. The operator accepts/rejects via UI (PR-7).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 7) THEN

    -- ============================================================
    -- synthetic_domain_propagation_rules · if-then rules
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'synthetic_domain_propagation_rules'
    ) THEN
      CREATE TABLE synthetic_domain_propagation_rules (
        id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL REFERENCES synthetic_domains(id) ON DELETE CASCADE,
        workspace_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        trigger JSONB NOT NULL,
        action JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','paused','archived')),
        last_fired_at TIMESTAMPTZ,
        fire_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_sdpr_domain ON synthetic_domain_propagation_rules(domain_id);
      CREATE INDEX idx_sdpr_status_active ON synthetic_domain_propagation_rules(status) WHERE status = 'active';
    END IF;

    -- ============================================================
    -- synthetic_domain_recommendations · advisory entities
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'synthetic_domain_recommendations'
    ) THEN
      CREATE TABLE synthetic_domain_recommendations (
        id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL REFERENCES synthetic_domains(id) ON DELETE CASCADE,
        workspace_id TEXT,
        rule_id TEXT REFERENCES synthetic_domain_propagation_rules(id) ON DELETE SET NULL,
        source_event_ids TEXT[] NOT NULL DEFAULT '{}',
        source_project_ids TEXT[] NOT NULL DEFAULT '{}',
        kind TEXT NOT NULL CHECK (kind IN (
          'extend_timeline','add_goal','add_roadmap_item',
          'mark_goal_complete','mark_roadmap_item_complete',
          'flag_blocker','reorder_roadmap','update_member_set','archive_domain'
        )),
        payload JSONB NOT NULL,
        rationale TEXT NOT NULL,
        confidence NUMERIC NOT NULL DEFAULT 0.7 CHECK (confidence BETWEEN 0 AND 1),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','accepted','rejected','expired','superseded')),
        generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        acted_by TEXT,
        acted_at TIMESTAMPTZ,
        resolution_note TEXT
      );
      CREATE INDEX idx_sdrec_domain_pending ON synthetic_domain_recommendations(domain_id)
        WHERE status = 'pending';
      CREATE INDEX idx_sdrec_expires ON synthetic_domain_recommendations(expires_at)
        WHERE status = 'pending';
      CREATE INDEX idx_sdrec_rule ON synthetic_domain_recommendations(rule_id)
        WHERE rule_id IS NOT NULL;
    END IF;

    -- ============================================================
    -- propagation_tick_state · worker bookkeeping (single row)
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'propagation_tick_state'
    ) THEN
      CREATE TABLE propagation_tick_state (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- single-row table
        last_tick_at TIMESTAMPTZ NOT NULL DEFAULT (now() - INTERVAL '1 hour'),
        last_event_ts TIMESTAMPTZ,
        ticks_run INTEGER NOT NULL DEFAULT 0,
        recommendations_generated INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_at TIMESTAMPTZ
      );
      INSERT INTO propagation_tick_state (id) VALUES (1) ON CONFLICT DO NOTHING;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (7, 'R49 PR-5+6: propagation_rules + recommendations + tick_state · LEM-v3 signal engine', now());
  END IF;
END $$;

COMMIT;
