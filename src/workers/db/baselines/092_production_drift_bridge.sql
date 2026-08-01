-- REPLAY-ONLY BASELINE: schema-92 production drift bridge.
--
-- This file is not a production migration and must never be applied to a live database. It exists
-- only so an empty disposable PostgreSQL database can replay the canonical worker migration stream.
-- Production acquired these three tables through historical paths outside
-- src/workers/db/migrations; migration 092 correctly fails closed when they are absent.
--
-- The bridge reproduces the measured schema shape without copying any production rows. It is
-- applied by scripts/replay-schema93-postgres.mjs immediately before migration 092, then migration
-- 092 enables RLS exactly as it did in production. Applied migrations remain immutable.

BEGIN;

CREATE TABLE IF NOT EXISTS public.investor_entitlements (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES public.users(id),
  workspace_id        TEXT REFERENCES public.workspaces(id),
  tier                TEXT NOT NULL CHECK (tier IN ('tier-1', 'tier-2')),
  scope_project_ref   TEXT DEFAULT 'x-biz-investor-readiness',
  granted_at          TEXT NOT NULL,
  granted_by          TEXT NOT NULL REFERENCES public.users(id),
  revoked_at          TEXT,
  revoked_by          TEXT REFERENCES public.users(id),
  revoked_reason      TEXT,
  section_filter_json TEXT DEFAULT '{"mode": "all-ready"}',
  metadata            TEXT DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, scope_project_ref)
);

CREATE INDEX IF NOT EXISTS idx_investor_entitlements_user
  ON public.investor_entitlements(user_id);
CREATE INDEX IF NOT EXISTS idx_investor_entitlements_workspace
  ON public.investor_entitlements(workspace_id);
CREATE INDEX IF NOT EXISTS idx_investor_entitlements_tier
  ON public.investor_entitlements(tier);

-- A clean replay starts with the canonical provider-based user_source_connections table, so the
-- conditional rename in migration 017 never creates this preserved legacy table. Migration 092
-- nevertheless names it because production still retains the historical rows.
CREATE TABLE IF NOT EXISTS public.user_source_connections_legacy_v0_260606 (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  workspace_id             TEXT,
  source_type              TEXT NOT NULL CHECK (source_type IN (
                             'github', 'gitlab', 'bitbucket', 'gdrive',
                             'dropbox', 'onedrive', 'local_folder', 'notion'
                           )),
  provider_account_id      TEXT,
  provider_installation_id TEXT,
  oauth_token_encrypted    TEXT,
  webhook_secret           TEXT,
  scopes                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                             'pending', 'connected', 'error', 'revoked'
                           )),
  last_sync_at             TIMESTAMPTZ,
  last_sync_error          TEXT,
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  contract                 JSONB NOT NULL DEFAULT '{
                             "read": {
                               "metadata": true,
                               "pr_status": true,
                               "issue_status": true,
                               "commit_summaries": true
                             },
                             "write": {
                               "open_issue": false,
                               "update_label": false,
                               "comment_review": false,
                               "propose_pr_comment": false
                             },
                             "ingestion_mode": "reflection_only",
                             "store_full_content": false,
                             "max_body_bytes_per_event": 200
                           }'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_usc_user_legacy_v0_260606
  ON public.user_source_connections_legacy_v0_260606(user_id);
CREATE INDEX IF NOT EXISTS idx_usc_workspace_legacy_v0_260606
  ON public.user_source_connections_legacy_v0_260606(workspace_id);

CREATE TABLE IF NOT EXISTS public.source_repos (
  id              TEXT PRIMARY KEY,
  connection_id   TEXT NOT NULL
                    REFERENCES public.user_source_connections_legacy_v0_260606(id)
                    ON DELETE CASCADE,
  workspace_id    TEXT,
  project_id      TEXT REFERENCES public.projects(id) ON DELETE SET NULL,
  external_id     TEXT NOT NULL,
  name            TEXT NOT NULL,
  full_path       TEXT,
  default_branch  TEXT,
  last_commit_sha TEXT,
  last_sync_at    TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sr_conn_external
  ON public.source_repos(connection_id, external_id);
CREATE INDEX IF NOT EXISTS idx_sr_project
  ON public.source_repos(project_id)
  WHERE project_id IS NOT NULL;

COMMIT;
