-- 101_connector_oauth_grants.sql · separate source authorization from Clerk identity.
--
-- Connector OAuth grants are tenant/user-scoped credentials owned by Xlooop's
-- connector boundary. They are never Clerk external accounts and can therefore
-- be revoked without changing a user's sign-in methods. Token material is stored
-- only as a purpose-bound encrypted envelope; routes never return ciphertext.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 101) THEN
    CREATE TABLE connector_oauth_grants (
      id                    TEXT        PRIMARY KEY,
      workspace_id          TEXT        NOT NULL,
      user_id               TEXT        NOT NULL,
      authority_provider    TEXT        NOT NULL CHECK (authority_provider IN ('google')),
      provider_account_id   TEXT        NOT NULL,
      provider_label        TEXT,
      scopes                TEXT[]      NOT NULL DEFAULT '{}',
      token_ciphertext      TEXT        NOT NULL,
      token_iv              TEXT        NOT NULL,
      access_expires_at     TIMESTAMPTZ,
      status                TEXT        NOT NULL DEFAULT 'active'
                                          CHECK (status IN ('active','refresh_required','revoked','error')),
      last_refresh_at       TIMESTAMPTZ,
      last_refresh_error    TEXT,
      revocation_verified_at TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, user_id, authority_provider, provider_account_id),
      UNIQUE (id, workspace_id, user_id)
    );

    CREATE TABLE connector_oauth_state_nonces (
      nonce_hash            TEXT        PRIMARY KEY,
      workspace_id          TEXT        NOT NULL,
      user_id               TEXT        NOT NULL,
      provider              TEXT        NOT NULL CHECK (provider IN ('google_drive','gmail')),
      expires_at            TIMESTAMPTZ NOT NULL,
      consumed_at           TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (expires_at > created_at)
    );

    ALTER TABLE user_source_connections
      ADD COLUMN IF NOT EXISTS oauth_grant_id TEXT;

    -- Legacy identity-backed connections remain one-per-user/provider.
    -- Dedicated grants are tenant-scoped, so the same employee may authorize
    -- the same provider independently for two companies without moving or
    -- sharing either tenant's credential authority.
    ALTER TABLE user_source_connections
      DROP CONSTRAINT IF EXISTS user_source_connections_user_id_provider_key;
    DROP INDEX IF EXISTS idx_usc_user_provider;
    CREATE UNIQUE INDEX user_source_connections_legacy_user_provider_key
      ON user_source_connections (user_id, provider)
      WHERE oauth_grant_id IS NULL;
    CREATE UNIQUE INDEX user_source_connections_tenant_user_provider_key
      ON user_source_connections (workspace_id, user_id, provider)
      WHERE oauth_grant_id IS NOT NULL;

    ALTER TABLE user_source_connections
      ADD CONSTRAINT user_source_connections_oauth_grant_workspace_fk
      FOREIGN KEY (oauth_grant_id, workspace_id, user_id)
      REFERENCES connector_oauth_grants (id, workspace_id, user_id)
      ON DELETE RESTRICT;

    CREATE INDEX connector_oauth_grants_active_owner_idx
      ON connector_oauth_grants (workspace_id, user_id, authority_provider)
      WHERE status = 'active';
    CREATE INDEX user_source_connections_oauth_grant_idx
      ON user_source_connections (oauth_grant_id)
      WHERE oauth_grant_id IS NOT NULL;
    CREATE INDEX connector_oauth_state_nonces_expiry_idx
      ON connector_oauth_state_nonces (expires_at)
      WHERE consumed_at IS NULL;

    ALTER TABLE connector_oauth_grants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE connector_oauth_state_nonces ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS connector_oauth_grants_workspace_policy ON connector_oauth_grants;
    CREATE POLICY connector_oauth_grants_workspace_policy ON connector_oauth_grants
      USING (workspace_id = xlooop_rls_workspace_id())
      WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    DROP POLICY IF EXISTS connector_oauth_state_nonces_workspace_policy ON connector_oauth_state_nonces;
    CREATE POLICY connector_oauth_state_nonces_workspace_policy ON connector_oauth_state_nonces
      USING (workspace_id = xlooop_rls_workspace_id())
      WITH CHECK (workspace_id = xlooop_rls_workspace_id());

    -- Intentionally no SELECT grant to xlooop_app: only the Worker owner-side
    -- credential service may read encrypted connector token envelopes.
    REVOKE ALL ON connector_oauth_grants FROM xlooop_app;
    REVOKE ALL ON connector_oauth_state_nonces FROM xlooop_app;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (101, 'dedicated tenant connector OAuth grants and source binding', now());
  END IF;
END $$;

COMMIT;

-- Verify after applying to an isolated branch:
--   SELECT version FROM workers_schema_version WHERE version = 101;
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'connector_oauth_grants';
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = 'connector_oauth_grants' AND grantee = 'xlooop_app'; -- expect no rows
