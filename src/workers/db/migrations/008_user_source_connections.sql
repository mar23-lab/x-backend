-- 008_user_source_connections.sql · R50.3a Clerk OAuth source connectors · 2026-05-28
--
-- Formalizes the pre-staged user_source_connections table (created ad-hoc in
-- prod Neon via psql; never persisted as a migration) and extends the
-- operation_events.source_tool CHECK constraint to admit the 5 new source
-- types emitted by R50.3c translators (github, google_drive, dropbox, gitlab,
-- microsoft_onedrive).
--
-- Scope (R50.3a only · per ~/.claude/plans/can-you-see-the-precious-prism.md):
--   1. CREATE TABLE user_source_connections IF NOT EXISTS (idempotent;
--      matches the pre-staged Neon shape; if prod-Neon shape diverges,
--      operator reconciles in a follow-up before R50.3b ships)
--   2. ALTER TABLE operation_events · drop + re-add source_tool CHECK
--      with the 5 new values
--
-- Out of scope for R50.3a (lands in R50.3b/c/d/e):
--   * clerk-oauth-adapter wiring · R50.3b
--   * /api/v1/sources REST surface · R50.3b
--   * 5-translator implementation · R50.3c
--   * Sync cron + rate limiter · R50.3d
--   * + ADD SOURCE UX modal · R50.3e
--
-- Provider taxonomy (matches docs/architecture/CLERK_OAUTH_PROVIDER_CONFIG.md):
--   * github               · GitHub commits/PRs/issues (metadata-only)
--   * google_drive         · Google Drive folder/file metadata
--   * dropbox              · Dropbox folder metadata
--   * gitlab               · GitLab commits/MRs/issues (metadata-only)
--   * microsoft_onedrive   · OneDrive metadata
--
-- Free-tier discipline: 5 simultaneous providers per Clerk free plan.
-- Bitbucket / Notion / Slack queue for paid-trigger (NOT in this CHECK).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 8) THEN

    -- ============================================================
    -- user_source_connections · per-user-per-provider OAuth binding
    -- ============================================================
    -- One row per (user_id, provider) pair. Tokens are NOT stored here ·
    -- Clerk manages tokens server-side and R50.3b's adapter fetches them
    -- on-demand via clerkClient.users.getUserOauthAccessToken(). This table
    -- stores the binding fact + sync state + the per-row read contract.
    --
    -- contract JSONB shape:
    --   {
    --     "version": 1,
    --     "ingestion_mode": "reflection_only",
    --     "allowed_fields": ["title","subject","timestamp","author_login"],
    --     "max_body_bytes": 200,
    --     "rate_limit": { "per_hour": 5000 }
    --   }
    -- The R50.3c contract-enforcer reads this column and rejects events
    -- that violate the declared shape before INSERT.

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'user_source_connections'
    ) THEN
      CREATE TABLE user_source_connections (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT,
        user_id             TEXT NOT NULL,
        provider            TEXT NOT NULL
                              CHECK (provider IN (
                                'github',
                                'google_drive',
                                'dropbox',
                                'gitlab',
                                'microsoft_onedrive'
                              )),
        provider_user_id    TEXT,
        provider_username   TEXT,
        scopes              TEXT[] NOT NULL DEFAULT '{}',
        contract            JSONB NOT NULL DEFAULT '{
                              "version": 1,
                              "ingestion_mode": "reflection_only",
                              "allowed_fields": ["title","subject","timestamp","author_login"],
                              "max_body_bytes": 200,
                              "rate_limit": {"per_hour": 5000}
                            }'::jsonb,
        status              TEXT NOT NULL DEFAULT 'connected'
                              CHECK (status IN (
                                'connected',
                                'disconnected',
                                'revoked',
                                'error',
                                'pending'
                              )),
        connected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_sync_at        TIMESTAMPTZ,
        last_sync_error     TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, provider)
      );
      CREATE INDEX idx_usc_user_provider
        ON user_source_connections(user_id, provider);
      CREATE INDEX idx_usc_workspace
        ON user_source_connections(workspace_id, status);
      CREATE INDEX idx_usc_sync_due
        ON user_source_connections(status, last_sync_at)
        WHERE status = 'connected';
    END IF;

    -- ============================================================
    -- operation_events.source_tool CHECK extension
    -- ============================================================
    -- Adds: github, google_drive, dropbox, gitlab, microsoft_onedrive
    -- Preserves: codex, claude, harness, mbp, xlooop, operator (R39/001 set)
    --
    -- Postgres pattern: DROP + ADD because there is no ALTER CHECK.
    -- The constraint name from 001_init.sql is the auto-generated
    -- 'operation_events_source_tool_check'. If a future migration ever
    -- introduces a named version, this DROP must be updated.

    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'operation_events_source_tool_check'
    ) THEN
      ALTER TABLE operation_events
        DROP CONSTRAINT operation_events_source_tool_check;
    END IF;

    ALTER TABLE operation_events
      ADD CONSTRAINT operation_events_source_tool_check
      CHECK (source_tool IN (
        'codex',
        'claude',
        'harness',
        'mbp',
        'xlooop',
        'operator',
        'github',
        'google_drive',
        'dropbox',
        'gitlab',
        'microsoft_onedrive'
      ));

    -- ============================================================
    -- Bookkeeping
    -- ============================================================
    INSERT INTO workers_schema_version (version, applied_at, description)
    VALUES (
      8,
      now(),
      'R50.3a · formalize user_source_connections + extend operation_events.source_tool CHECK with 5 OAuth source providers (github, google_drive, dropbox, gitlab, microsoft_onedrive)'
    );

  END IF;
END
$$;

COMMIT;
