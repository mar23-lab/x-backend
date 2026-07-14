-- 053_model_runtimes.sql · Wave C (260708) · per-workspace model-runtime provider config with
-- ENCRYPTED-AT-REST customer credentials, a workspace default, and a per-user session override.
--
-- WHY: the new-UI Settings surface (controls n129–136) lets a workspace configure up to 13 model
-- providers (8 cloud + 5 local), each with its own credential + base_url, pick a workspace default, and
-- let a user override the provider for their own session. Cloudflare Workers have NO per-tenant secret
-- vault, so a customer's provider credential is encrypted-at-rest here (AES-256-GCM; see
-- src/workers/lib/model-runtime-crypto.ts). This table stores ONLY the ciphertext + iv + last4 — never the
-- plaintext key, never the master key (that is a worker secret, MODEL_RUNTIME_ENC_KEY).
--
-- Idempotent + version-guarded (copies the 052 DO-block form). Additive only. Prod apply is
-- OPERATOR-NAMED and manual (one migration at a time, read-verify before + after) — NEVER auto-applied
-- from an agent workflow. Validate against a throwaway local Postgres first.

BEGIN;

DO $$
DECLARE cn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 53) THEN

    -- (1) The per-(workspace, provider) config row. Credential columns hold ciphertext ONLY.
    CREATE TABLE IF NOT EXISTS model_runtime_providers (
      id                    TEXT        PRIMARY KEY,                 -- app-generated (mrp_<rand>)
      workspace_id          TEXT        NOT NULL,                    -- tenant scope (RLS predicate)
      provider              TEXT        NOT NULL
                                        CHECK (provider IN (
                                          'anthropic','openai','google','mistral','deepseek',
                                          'azure_openai','aws_bedrock','openrouter',
                                          'ollama','lm_studio','vllm','llama_cpp','custom')),
      auth_kind             TEXT        NOT NULL
                                        CHECK (auth_kind IN ('none','api_key','azure_key','aws_sigv4','custom')),
      base_url              TEXT,                                    -- required for local/azure/custom; NULL = vendor default
      model                 TEXT,                                    -- optional default model id for this provider
      credential_ciphertext TEXT,                                    -- base64(AES-256-GCM ct+tag); NULL for keyless-local
      credential_iv         TEXT,                                    -- base64(12-byte iv); NULL iff ciphertext NULL
      credential_last4      TEXT,                                    -- masked-display tail; NULL iff no credential
      enc_version           SMALLINT    NOT NULL DEFAULT 1,          -- RESERVED for a future key-rotation impl
                                                                     -- (NOT wired yet — rotating the master key
                                                                     -- today orphans existing ciphertext; see
                                                                     -- MODEL_RUNTIMES_ACTIVATION.md § Key rotation)
      enabled               BOOLEAN     NOT NULL DEFAULT true,
      is_default            BOOLEAN     NOT NULL DEFAULT false,
      created_by            TEXT        NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, provider),                              -- one config per provider per workspace
      UNIQUE (id, workspace_id)                                     -- composite-FK target for same-workspace override
    );

    -- At most ONE default provider per workspace. A plain UNIQUE(workspace_id, is_default) does NOT enforce
    -- this (it allows many is_default=false rows) — a PARTIAL unique index on the true rows is the correct
    -- shape (same gotcha the 044 soft-delete work hit).
    CREATE UNIQUE INDEX IF NOT EXISTS model_runtime_providers_one_default
      ON model_runtime_providers (workspace_id) WHERE is_default;

    -- (2) The per-user session override — which provider a user's session uses instead of the workspace
    -- default. Modeled like 052 user_session_preferences (PK user_id+workspace_id). CASCADE so removing a
    -- provider clears any override that pointed at it.
    CREATE TABLE IF NOT EXISTS user_runtime_override (
      user_id       TEXT        NOT NULL,
      workspace_id  TEXT        NOT NULL,
      provider_id   TEXT        NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, workspace_id),
      -- Composite FK: an override can ONLY reference a provider in the SAME workspace (DB-enforced tenant
      -- isolation — not merely the route's pre-check). CASCADE clears the override when the provider is removed.
      FOREIGN KEY (provider_id, workspace_id)
        REFERENCES model_runtime_providers (id, workspace_id) ON DELETE CASCADE
    );

    -- (3) RLS defense-in-depth (043/045/052 recipe): a second layer behind the app-level workspace_id WHERE.
    -- Inert for current paths (the store routes through the owner sql, which bypasses RLS); real when a
    -- restricted xlooop_app read is ever routed through withWorkspaceRlsContext.
    GRANT USAGE ON SCHEMA public TO xlooop_app;
    GRANT SELECT ON model_runtime_providers TO xlooop_app;
    GRANT SELECT ON user_runtime_override TO xlooop_app;

    ALTER TABLE model_runtime_providers ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS model_runtime_providers_workspace_policy ON model_runtime_providers;
    CREATE POLICY model_runtime_providers_workspace_policy ON model_runtime_providers
      USING (workspace_id = xlooop_rls_workspace_id())
      WITH CHECK (workspace_id = xlooop_rls_workspace_id());

    ALTER TABLE user_runtime_override ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS user_runtime_override_workspace_policy ON user_runtime_override;
    CREATE POLICY user_runtime_override_workspace_policy ON user_runtime_override
      USING (workspace_id = xlooop_rls_workspace_id())
      WITH CHECK (workspace_id = xlooop_rls_workspace_id());

    -- (4) Widen the audit_logs.target_type CHECK to accept 'model_runtime_provider' so the audited
    -- default-provider flip can INSERT (021 CHECK, last widened by 048). Drop by LIVE name (the constraint
    -- name may vary), recreate as the full 048 superset PLUS the new value — never drop an existing value.
    SELECT conname INTO cn FROM pg_constraint
      WHERE conrelid = 'audit_logs'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%target_type%'
      LIMIT 1;
    IF cn IS NOT NULL THEN
      EXECUTE format('ALTER TABLE audit_logs DROP CONSTRAINT %I', cn);
    END IF;
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_target_type_check CHECK (target_type IN (
      'user', 'workspace_member', 'access_request', 'workspace', 'project',
      'synthetic_domain', 'synthetic_domain_roadmap', 'synthetic_domain_roadmap_item',
      'synthetic_domain_goal', 'synthetic_domain_propagation_rule', 'synthetic_domain_recommendation',
      'event', 'packet', 'decision', 'sign_off',
      'api_token', 'session',
      'model_runtime_provider'
    ));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (53, 'model_runtime_providers + user_runtime_override (+RLS) + audit target_type +model_runtime_provider — Wave C', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT version FROM workers_schema_version WHERE version = 53;                                    -- expect 1 row
--   SELECT relrowsecurity FROM pg_class WHERE relname IN ('model_runtime_providers','user_runtime_override'); -- expect t, t
--   SELECT policyname, cmd FROM pg_policies WHERE tablename IN ('model_runtime_providers','user_runtime_override');
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid='audit_logs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%target_type%'; -- includes model_runtime_provider
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'model_runtime_providers_one_default';         -- partial WHERE is_default
