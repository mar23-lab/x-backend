-- 028_synthetic_domain_source_context.sql · ADR-XLOOP-IA-001 R1
--
-- WHY
--   R1 "Domains = context-lenses (incl. companies); connect-a-source auto-links by context".
--   A Domain is ONE primitive (synthetic_domain, L2) with a `kind` discriminator -- the DDD
--   lesson applied (HR-NO-PARALLEL-MODEL-1): a "kind of X" is a discriminator on the X
--   aggregate, not a new aggregate. "Companies" = kind=company; Career/Health = kind=life;
--   "Investor-facing" = kind=work.
--
-- WHAT (additive, idempotent -- no L0 mutation, no data rewrite)
--   * kind             — the discriminator. Default 'work' (the existing implicit default).
--   * source_domain_id — the one-way "mirror lens" backref to an external MB-P life-domain
--                        graph node. The MB-P node stays the SSOT and is NEVER mutated from
--                        Xlooop; this column only records WHICH external node a kind=life lens
--                        mirrors. NULL for ordinary lenses. This is construction IP and is
--                        stripped from tenant responses (HR-IP-BOUNDARY-1); `kind` itself is
--                        tenant-safe (a customer must see that their lens is a 'company' lens).
--
-- APPLY: prod Neon migrations are applied MANUALLY (operator-gated). `verify-prod-migrations.mjs`
--        will correctly report 028 as apply-pending until the operator runs it against prod.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 28) THEN

    ALTER TABLE synthetic_domains
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'work'
        CHECK (kind IN ('life','company','work','custom'));

    ALTER TABLE synthetic_domains
      ADD COLUMN IF NOT EXISTS source_domain_id TEXT NULL;

    -- A kind=life mirror lens SHOULD carry the external backref; a non-life lens MUST NOT.
    -- (Soft invariant: enforced in the DAL, not as a hard CHECK, so legacy rows with the
    --  'work' default and NULL backref remain valid without a backfill.)
    COMMENT ON COLUMN synthetic_domains.source_domain_id IS
      'One-way mirror-lens backref to an external MB-P life-domain node (kind=life only). Operator construction IP -- stripped from tenant responses.';

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (28, 'R1 · synthetic_domains.kind discriminator + source_domain_id mirror-lens backref (additive)', now());
  END IF;
END $$;

COMMIT;
