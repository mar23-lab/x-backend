-- 074_typed_work_relationships.sql · packet lineage edges — STAGED ONLY.
-- One envelope supports packet->packet and packet->goal, with pair-specific vocabularies.
-- No production apply or UI exposure is authorized in this wave.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 74) THEN
    CREATE TABLE IF NOT EXISTS work_relationships (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_packet_id  TEXT NOT NULL REFERENCES task_packets(id) ON DELETE CASCADE,
      target_kind       TEXT NOT NULL CHECK (target_kind IN ('packet', 'goal')),
      target_id         TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      created_by        TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at        TIMESTAMPTZ,
      CHECK (
        (target_kind = 'packet' AND relationship_type IN ('depends_on', 'blocks', 'supersedes', 'duplicates')) OR
        (target_kind = 'goal' AND relationship_type IN ('advances', 'contributes_to', 'measures', 'blocked_by'))
      ),
      CHECK (target_kind <> 'packet' OR source_packet_id <> target_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_work_relationships_active_shape
      ON work_relationships(workspace_id, source_packet_id, target_kind, target_id, relationship_type)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_work_relationships_source
      ON work_relationships(workspace_id, source_packet_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_work_relationships_target
      ON work_relationships(workspace_id, target_kind, target_id) WHERE deleted_at IS NULL;

    CREATE OR REPLACE FUNCTION xlooop_assert_work_relationship_scope()
    RETURNS TRIGGER LANGUAGE plpgsql AS $REL$
    DECLARE source_ws TEXT; target_matches INTEGER;
    BEGIN
      SELECT workspace_id INTO source_ws FROM task_packets WHERE id = NEW.source_packet_id;
      IF source_ws IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'source_packet_id belongs to another workspace';
      END IF;
      IF NEW.target_kind = 'packet' THEN
        SELECT count(*) INTO target_matches FROM task_packets
          WHERE id = NEW.target_id AND workspace_id = NEW.workspace_id;
      ELSE
        SELECT (
          (SELECT count(*) FROM plan_entities
            WHERE id = NEW.target_id AND workspace_id = NEW.workspace_id AND kind = 'goal') +
          (SELECT count(*) FROM synthetic_domain_goals
            WHERE id = NEW.target_id AND workspace_id = NEW.workspace_id)
        ) INTO target_matches;
      END IF;
      IF target_matches = 0 THEN RAISE EXCEPTION 'target_id does not exist in this workspace'; END IF;
      IF target_matches > 1 THEN RAISE EXCEPTION 'target_id is ambiguous across goal authorities'; END IF;
      RETURN NEW;
    END;
    $REL$;

    DROP TRIGGER IF EXISTS trg_work_relationship_scope ON work_relationships;
    CREATE TRIGGER trg_work_relationship_scope
      BEFORE INSERT OR UPDATE ON work_relationships
      FOR EACH ROW EXECUTE FUNCTION xlooop_assert_work_relationship_scope();

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE work_relationships ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS work_relationships_workspace_policy ON work_relationships;
      CREATE POLICY work_relationships_workspace_policy ON work_relationships
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
      GRANT SELECT, INSERT, UPDATE ON work_relationships TO xlooop_app;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (74, 'typed packet->packet and packet->goal relationship envelope with pair-specific vocabulary, same-workspace target validation, soft-delete, RLS', now());
  END IF;
END $$;

COMMIT;
