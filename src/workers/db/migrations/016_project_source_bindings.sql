-- 016_project_source_bindings.sql · Project source binding v1 · 2026-06-04
--
-- Links a stable project/domain id to a source reference without making source
-- labels or mutable names authoritative. OAuth authority remains in
-- user_source_connections; this table only scopes a project to a source.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 16) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'project_source_bindings'
    ) THEN
      CREATE TABLE IF NOT EXISTS project_source_bindings (
        id                        TEXT PRIMARY KEY,
        workspace_id              TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id                TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_kind               TEXT NOT NULL CHECK (source_kind IN (
                                      'github_repo',
                                      'google_drive_folder',
                                      'desktop_folder',
                                      'manual'
                                    )),
        user_source_connection_id TEXT REFERENCES user_source_connections(id) ON DELETE SET NULL,
        source_ref                JSONB NOT NULL DEFAULT '{}',
        status                    TEXT NOT NULL DEFAULT 'pending_auth' CHECK (status IN (
                                      'pending_auth',
                                      'connected',
                                      'reconnect_required',
                                      'disabled_preview',
                                      'archived'
                                    )),
        read_policy               TEXT NOT NULL DEFAULT 'metadata_only' CHECK (read_policy IN (
                                      'metadata_only',
                                      'proposal_only',
                                      'read_only'
                                    )),
        connected_by              TEXT,
        connected_at              TIMESTAMPTZ,
        last_verified_at          TIMESTAMPTZ,
        reconnect_required_reason TEXT,
        metadata                  JSONB NOT NULL DEFAULT '{}',
        created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    END IF;

    CREATE INDEX IF NOT EXISTS idx_project_source_bindings_project
      ON project_source_bindings(workspace_id, project_id, status);
    CREATE INDEX IF NOT EXISTS idx_project_source_bindings_user_source
      ON project_source_bindings(user_source_connection_id)
      WHERE user_source_connection_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_project_source_bindings_active_ref
      ON project_source_bindings(project_id, source_kind, (source_ref::text))
      WHERE status <> 'archived';

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (16, 'Project source binding v1 · stable project/domain source scope without name authority', now());
  END IF;
END $$;

COMMIT;
