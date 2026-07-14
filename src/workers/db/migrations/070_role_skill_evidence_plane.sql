-- 070_role_skill_evidence_plane.sql · OAR-W2 (260713) · role/skill resolution EVIDENCE PLANE — STAGED.
--
-- WHY (ADR-ABS-006 + OAR mission Phases 2-3). Role AUTHORITY is mechanical + server-side, but SKILL
-- selection had no runtime home and no receipts: resolution coverage 0, invocation receipts 0, closing
-- attestations 0, and denials were console.warn-only (audit Matrix A). This migration lays the durable
-- evidence plane the shadow resolver (lib/role-skill-resolver.ts → lib/role-skill-shadow.ts) writes to,
-- so those metrics become measured instead of absent.
--
-- SHAPE / DOCTRINE (from the mig-035 + 063 reconnaissance):
--   * NO NEW CATALOG TABLES. The catalog is mig-035 template_definitions (category is a length-only
--     CHECK, so 'role'/'skill'/'pack'/'tool' already fit) + immutable template_versions. This migration
--     only ADDS a classification column + a 'blocked' version lifecycle to that existing catalog, and
--     defensively REVOKEs catalog writes from the runtime app role (HR-NO-PARALLEL-MODEL-1 by construction).
--   * DENORMALIZE-BY-VALUE. Every evidence table stores role_key/version/content_sha256 as NOT NULL TEXT
--     and links to the catalog only through a NULLABLE FK (... ON DELETE SET NULL). This is deliberate:
--     policy_decisions.policy_id NOT NULL FK-RESTRICT to the empty policy_definitions is UNWRITABLE
--     until seeded (see lib/policy-shadow.ts:10-14). The shadow resolver must be able to write receipts
--     TODAY, against a zero-row catalog, so no NOT-NULL catalog FK appears here.
--   * RLS = the 063 house recipe: pg_proc-guarded ENABLE + workspace policy via xlooop_rls_workspace_id().
--     Worker writes owner-connected (like 063/064/065/066), so NO xlooop_app GRANT is added — the RLS
--     second layer bites only if reads are ever routed through the RLS-subject role (matches 063 exactly).
--
-- Additive-only; reversible (DROP the 4 tables; DROP COLUMN classification; restore the 035 lifecycle
-- CHECK to its 5-literal set; re-GRANT if ever needed). Validate against a throwaway local Postgres
-- before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
DECLARE
  cn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 70) THEN

    -- (A) mig-035 catalog: forward-looking classification + 'blocked' lifecycle (ADR-ABS-009 W8 uses it).
    --     Zero rows today ⇒ CHECK-widening is risk-free. classification defaults to the safest tier.
    ALTER TABLE template_definitions
      ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'internal_sensitive'
        CHECK (classification IN ('public', 'customer_visible', 'internal_sensitive'));

    -- widen template_versions.lifecycle_state to admit 'blocked' (a publisher-side kill switch). The
    -- inline CHECK has an auto-generated name; discover it dynamically (053 pattern) then recreate.
    SELECT conname INTO cn
      FROM pg_constraint
      WHERE conrelid = 'template_versions'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%lifecycle_state%';
    IF cn IS NOT NULL THEN
      EXECUTE format('ALTER TABLE template_versions DROP CONSTRAINT %I', cn);
    END IF;
    ALTER TABLE template_versions
      ADD CONSTRAINT template_versions_lifecycle_state_check
      CHECK (lifecycle_state IN ('draft', 'approved', 'active', 'deprecated', 'archived', 'blocked'));

    -- (B) EVIDENCE TABLE 1: role_skill_resolutions — one row per governed-write resolution attempt.
    --     This is the table that moves "resolution coverage" and "receipts-missing" off zero.
    CREATE TABLE IF NOT EXISTS role_skill_resolutions (
      id                 TEXT PRIMARY KEY,
      workspace_id       TEXT NOT NULL,                 -- value (RLS subject); loose (tenant may be mid-provision)
      principal_id       TEXT NOT NULL,
      role_key           TEXT NOT NULL,                 -- denormalized; = catalog role_key once published
      role_version       TEXT NOT NULL DEFAULT 'v0',
      action             TEXT NOT NULL,
      mode               TEXT NOT NULL,
      intent_ref         TEXT,
      selected_skills    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{key,version}]
      allowed_tools      TEXT[] NOT NULL DEFAULT '{}',
      denied_tools       TEXT[] NOT NULL DEFAULT '{}',
      required_approvals TEXT[] NOT NULL DEFAULT '{}',
      skill_coverage     TEXT NOT NULL
                           CHECK (skill_coverage IN ('resolved', 'no_skill_for_action', 'no_catalog')),
      resolver_verdict   TEXT NOT NULL
                           CHECK (resolver_verdict IN ('resolved', 'tenant_mismatch', 'mode_requires_operator',
                                                       'entitlement_missing', 'skill_stale', 'skill_not_installed')),
      resolver_allowed   BOOLEAN NOT NULL,
      actual_reason      TEXT NOT NULL,                 -- the SpineWriteDecision.reason actually returned
      actual_allowed     BOOLEAN NOT NULL,
      agreement          TEXT NOT NULL
                           CHECK (agreement IN ('agree', 'resolver_stricter', 'resolver_looser')),
      content_sha256     TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      signature_alg      TEXT NOT NULL DEFAULT 'none' CHECK (signature_alg IN ('none', 'HS256')),
      signature          TEXT,                          -- base64url HMAC when the secret is configured
      signing_key_id     TEXT,                          -- rotation label
      catalog_version_id TEXT REFERENCES template_versions(id) ON DELETE SET NULL,  -- NULLABLE (trap-safe)
      -- provenance (OAR activation-readiness review, 260713): WHICH binding source produced this
      -- resolution, and WHICH deployed build observed it — so a receipt is auditable against the
      -- catalog/deploy state that existed when it was written (pre-apply amendment; 070 never applied).
      resolver_source    TEXT NOT NULL DEFAULT 'v0-floor'
                           CHECK (resolver_source IN ('v0-floor', 'catalog', 'mixed')),
      deploy_sha         TEXT,                          -- build SHA of the observing Worker (null if unstamped)
      catalog_manifest_sha256 TEXT CHECK (catalog_manifest_sha256 IS NULL OR catalog_manifest_sha256 ~ '^[a-f0-9]{64}$'),
      expires_at         TIMESTAMPTZ NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_role_skill_resolutions_ws
      ON role_skill_resolutions (workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_role_skill_resolutions_coverage
      ON role_skill_resolutions (skill_coverage, created_at DESC);

    -- (C) EVIDENCE TABLE 2: authority_denial_receipts — upgrades the console-only deny log to a durable,
    --     queryable, customer-safe receipt. Written in W2 for every governed-write DENY.
    CREATE TABLE IF NOT EXISTS authority_denial_receipts (
      id                 TEXT PRIMARY KEY,
      workspace_id       TEXT NOT NULL,
      principal_id       TEXT NOT NULL,
      role_key           TEXT NOT NULL,
      action             TEXT NOT NULL,
      mode               TEXT NOT NULL,
      denied_by          TEXT NOT NULL CHECK (denied_by IN ('entitlement', 'resolver', 'both')),
      entitlement_reason TEXT,
      resolver_reason    TEXT,
      safe_explanation   TEXT NOT NULL CHECK (char_length(safe_explanation) <= 1000),  -- no internal ids
      content_sha256     TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      signature_alg      TEXT NOT NULL DEFAULT 'none' CHECK (signature_alg IN ('none', 'HS256')),
      signature          TEXT,
      signing_key_id     TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_authority_denial_receipts_ws
      ON authority_denial_receipts (workspace_id, created_at DESC);

    -- (D) EVIDENCE TABLE 3: skill_invocation_receipts — reserved for the closed loop (OAR-W6): one row
    --     per ACTUAL skill invocation. Ships empty in W2; the schema exists so W6 is additive-only.
    CREATE TABLE IF NOT EXISTS skill_invocation_receipts (
      id                 TEXT PRIMARY KEY,
      workspace_id       TEXT NOT NULL,
      resolution_id      TEXT REFERENCES role_skill_resolutions(id) ON DELETE SET NULL,
      principal_id       TEXT NOT NULL,
      skill_key          TEXT NOT NULL,
      skill_version      TEXT NOT NULL,
      action             TEXT NOT NULL,
      status             TEXT NOT NULL CHECK (status IN ('invoked', 'completed', 'failed', 'denied')),
      evidence_ref_ids   TEXT[] NOT NULL DEFAULT '{}',
      content_sha256     TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      signature_alg      TEXT NOT NULL DEFAULT 'none' CHECK (signature_alg IN ('none', 'HS256')),
      signature          TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_skill_invocation_receipts_ws
      ON skill_invocation_receipts (workspace_id, created_at DESC);

    -- (E) EVIDENCE TABLE 4: closing_attestations — reserved for the closed loop (OAR-W6): one row per
    --     session/wave closeout attestation (ports MB-P closing_skills). Ships empty in W2.
    CREATE TABLE IF NOT EXISTS closing_attestations (
      id                 TEXT PRIMARY KEY,
      workspace_id       TEXT NOT NULL,
      principal_id       TEXT NOT NULL,
      correlation_id     TEXT,
      role_key           TEXT NOT NULL,
      closing_skill      TEXT NOT NULL,
      outcome            TEXT NOT NULL CHECK (outcome IN ('attested', 'skipped', 'failed')),
      evidence_ref_ids   TEXT[] NOT NULL DEFAULT '{}',
      content_sha256     TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      signature_alg      TEXT NOT NULL DEFAULT 'none' CHECK (signature_alg IN ('none', 'HS256')),
      signature          TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_closing_attestations_ws
      ON closing_attestations (workspace_id, created_at DESC);

    -- (F) RLS second layer (063 house recipe: pg_proc-guarded; workspace policy via the GUC reader).
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE role_skill_resolutions ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS role_skill_resolutions_workspace_policy ON role_skill_resolutions;
      CREATE POLICY role_skill_resolutions_workspace_policy ON role_skill_resolutions
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());

      ALTER TABLE authority_denial_receipts ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS authority_denial_receipts_workspace_policy ON authority_denial_receipts;
      CREATE POLICY authority_denial_receipts_workspace_policy ON authority_denial_receipts
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());

      ALTER TABLE skill_invocation_receipts ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS skill_invocation_receipts_workspace_policy ON skill_invocation_receipts;
      CREATE POLICY skill_invocation_receipts_workspace_policy ON skill_invocation_receipts
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());

      ALTER TABLE closing_attestations ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS closing_attestations_workspace_policy ON closing_attestations;
      CREATE POLICY closing_attestations_workspace_policy ON closing_attestations
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    -- (G) HR-NO-PARALLEL-MODEL-1 by construction: the runtime app role must never mutate the catalog.
    --     035 never granted catalog writes to xlooop_app, so this is defensive (guards a future accidental
    --     grant). REVOKE of a non-granted privilege is a no-op; guard on role existence so apply never errors.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
      REVOKE INSERT, UPDATE, DELETE ON template_definitions FROM xlooop_app;
      REVOKE INSERT, UPDATE, DELETE ON template_versions    FROM xlooop_app;
      REVOKE INSERT, UPDATE, DELETE ON policy_definitions   FROM xlooop_app;

      -- Evidence-plane READS through the RLS-subject role (activation-readiness review, 260713):
      -- SELECT-only, so the workspace RLS policies above can ever bite when a read route ships
      -- (045/046/047 precedent). Writes stay owner-plane (the shadow observer) by design.
      GRANT SELECT ON role_skill_resolutions      TO xlooop_app;
      GRANT SELECT ON authority_denial_receipts   TO xlooop_app;
      GRANT SELECT ON skill_invocation_receipts   TO xlooop_app;
      GRANT SELECT ON closing_attestations        TO xlooop_app;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (70, 'role/skill resolution evidence plane: role_skill_resolutions (+ resolver_source/deploy_sha/catalog_manifest_sha256 provenance) + authority_denial_receipts (written by the shadow resolver) + skill_invocation_receipts + closing_attestations (reserved W6); template classification + blocked lifecycle; catalog REVOKE + evidence SELECT grant for xlooop_app (OAR-W2 amended pre-apply by the activation-readiness review, ADR-ABS-006)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT count(*) FROM information_schema.tables
--     WHERE table_name IN ('role_skill_resolutions','authority_denial_receipts','skill_invocation_receipts','closing_attestations'); -- expect 4
--   SELECT column_name FROM information_schema.columns WHERE table_name='template_definitions' AND column_name='classification'; -- expect 1
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='template_versions_lifecycle_state_check'; -- includes 'blocked'
--   SELECT column_name FROM information_schema.columns WHERE table_name='role_skill_resolutions'
--     AND column_name IN ('resolver_source','deploy_sha','catalog_manifest_sha256'); -- expect 3
--   SELECT privilege_type FROM information_schema.role_table_grants
--     WHERE grantee='xlooop_app' AND table_name='role_skill_resolutions'; -- expect exactly SELECT
