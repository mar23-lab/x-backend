-- 018_customer_registration.sql · Customer registration persistence + authority/consent + entitlements · 2026-06-07
--
-- Persists the extended customer-registration payload from the x-web readiness funnel
-- (POST /api/v1/request-access · source='x-web-readiness-register'):
--
--   * readiness_assessments       — account_type + readiness Q&A + deep level (L0-L5) + public-signal
--                                    enrichment snapshot, linked 1:1 to an access_request
--                                    (idempotent via UNIQUE(access_request_id)).
--   * customer_authority_consents — the authority record that UNLOCKS private connectors + team invites
--                                    per CUSTOMER_ECOSYSTEM_ONBOARDING_AND_IP_BOUNDARY_STANDARD hard-gate.
--                                    Operator side (CLI approval, DR-11) + customer side (in-app typed-name
--                                    consent ack). Connectors/invites stay locked until BOTH are present
--                                    and the row is not revoked.
--   * customer_entitlements       — capability/mode layer mirroring investor_entitlements (NOT overloaded;
--                                    investor's is tier-specific to x-biz-investor-readiness). Product
--                                    access remains governed by users.status='approved' + active
--                                    workspace_members; this table is the modes/actions layer only.
--
-- Additive only (per BACKEND_ROLE_DEFINITION §4). access_requests gains account_type +
-- readiness_assessment_id (nullable; populated by the funnel). FKs reference existing 002 tables.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 18) THEN

    -- ============================================================
    -- readiness_assessments · readiness Q&A + enrichment snapshot
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'readiness_assessments'
    ) THEN
      CREATE TABLE readiness_assessments (
        id                  TEXT PRIMARY KEY,
        access_request_id   TEXT NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
        user_id             TEXT REFERENCES users(id),
        workspace_id        TEXT REFERENCES workspaces(id),
        email               TEXT NOT NULL,
        account_type        TEXT NOT NULL DEFAULT 'company'
                              CHECK (account_type IN ('personal', 'company', 'both')),
        also_personal_space BOOLEAN NOT NULL DEFAULT false,
        company_name        TEXT,
        domain              TEXT,
        country             TEXT,
        deep_level          INTEGER,
        readiness_answers   JSONB NOT NULL DEFAULT '{}',
        deep_check          JSONB,
        enrichment          JSONB,
        consent             JSONB NOT NULL DEFAULT '{}',
        source              TEXT,
        metadata            JSONB NOT NULL DEFAULT '{}',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (access_request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_readiness_assessments_email
        ON readiness_assessments(email);
      CREATE INDEX IF NOT EXISTS idx_readiness_assessments_user
        ON readiness_assessments(user_id) WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_readiness_assessments_workspace
        ON readiness_assessments(workspace_id) WHERE workspace_id IS NOT NULL;
    END IF;

    -- ============================================================
    -- customer_authority_consents · unlock record for connectors + team invites
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_authority_consents'
    ) THEN
      CREATE TABLE customer_authority_consents (
        id                   TEXT PRIMARY KEY,
        workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        access_request_id    TEXT REFERENCES access_requests(id),
        -- operator side (DR-11 · manual CLI approval)
        operator_approved_at TIMESTAMPTZ,
        operator_approved_by TEXT REFERENCES users(id),
        allowed_modes        TEXT[] NOT NULL DEFAULT ARRAY['watch']::TEXT[],
        allowed_apps         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        -- customer side (in-app typed-name consent acknowledgement)
        consent_acked_at     TIMESTAMPTZ,
        consent_acked_by     TEXT REFERENCES users(id),
        full_name_typed      TEXT,
        scopes_confirmed     JSONB NOT NULL DEFAULT '{}',
        consent_version      TEXT NOT NULL DEFAULT 'authority_v1',
        ip_address           TEXT,
        user_agent           TEXT,
        revoked_at           TIMESTAMPTZ,
        revoked_by           TEXT REFERENCES users(id),
        revoked_reason       TEXT,
        metadata             JSONB NOT NULL DEFAULT '{}',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- one active (non-revoked) authority record per workspace
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_authority_active
        ON customer_authority_consents(workspace_id) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_customer_authority_access_request
        ON customer_authority_consents(access_request_id) WHERE access_request_id IS NOT NULL;
    END IF;

    -- ============================================================
    -- customer_entitlements · capability/mode layer (mirror of investor_entitlements)
    -- ============================================================
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_entitlements'
    ) THEN
      CREATE TABLE customer_entitlements (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id),
        workspace_id    TEXT REFERENCES workspaces(id),
        app_id          TEXT NOT NULL DEFAULT 'xlooop-product',
        account_type    TEXT NOT NULL DEFAULT 'company'
                          CHECK (account_type IN ('personal', 'company', 'both')),
        allowed_modes   TEXT[] NOT NULL DEFAULT ARRAY['watch']::TEXT[],
        allowed_actions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        denied_actions  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        authority_ref   TEXT,
        granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        granted_by      TEXT NOT NULL REFERENCES users(id),
        revoked_at      TIMESTAMPTZ,
        revoked_by      TEXT REFERENCES users(id),
        revoked_reason  TEXT,
        metadata        JSONB NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, app_id)
      );
      CREATE INDEX IF NOT EXISTS idx_customer_entitlements_user
        ON customer_entitlements(user_id);
      CREATE INDEX IF NOT EXISTS idx_customer_entitlements_workspace
        ON customer_entitlements(workspace_id) WHERE workspace_id IS NOT NULL;
    END IF;

    -- access_requests gains account_type + a denormalized back-link to the assessment
    ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS account_type TEXT;
    ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS readiness_assessment_id TEXT;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (18, 'Customer registration persistence · readiness_assessments + customer_authority_consents + customer_entitlements + access_requests.account_type', now());

  END IF;
END $$;

COMMIT;
